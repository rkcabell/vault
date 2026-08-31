/**
 * Keeps a copy of everything the user added to their library — tags, edited
 * titles, stars, bundles and reminders — in one file, and puts it back after
 * the database is lost or rebuilt.
 *
 * Nothing is ever written next to a source file; the copy lives in Vault's own
 * storage.
 */
import { Readable } from "node:stream";
import type { SidecarEntry, SidecarExportResult, SidecarRestoreResult, SidecarStatus } from "@vault/types";
import type { StorageAdapter } from "../../adapters/storage/types.js";
import type {
  RestorePatch,
  RestoreTargetRow,
  SidecarRepository,
  SnapshotSourceRow,
} from "../../repositories/sidecarRepository.js";
import {
  encodeEntry,
  encodeHeader,
  encodeTagLine,
  parseHeader,
  parseLine,
  readLines,
  snapshotBackupKey,
  snapshotKey,
} from "../../lib/sidecar/snapshotFormat.js";
import type { RestoreStore } from "../../lib/sidecar/restoreState.js";


const EXPORT_PAGE = 500;
const RESTORE_CHUNK = 200;
const DEFAULT_INTERVAL_MS = 5 * 60_000;

type SidecarLogger = {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
  error: (obj: object, msg: string) => void;
};

export type SidecarServiceDeps = {
  repository: SidecarRepository;
  storage: StorageAdapter;
  bucket: string;
  logger: SidecarLogger;
  getMode: (userId: string) => Promise<"off" | "snapshot">;
  /** This user's chosen gap between snapshots, in minutes. */
  getIntervalMinutes: (userId: string) => Promise<number>;
  listUserIds: () => Promise<string[]>;
  /** MediaRepository's method of the same name, passed in so a test can confirm it ran. */
  reconcileTagCounts: (userId: string) => Promise<void>;
  /** Restore progress and its lock — see lib/sidecar/restoreState. */
  restoreStore: RestoreStore;
  intervalMs?: number;
};

export type SidecarService = ReturnType<typeof createSidecarService>;

export function createSidecarService (deps: SidecarServiceDeps) {
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;

  // Held in memory on purpose. A restart writes one snapshot that was not
  // needed, and in exchange there is never a question of whether a remembered
  // value still matches the file on disk. Restore progress is the opposite
  // case, and is kept in Redis.
  const lastProbe = new Map<string, string>();

  // When each user was last considered by tick(). Held here rather than re-read
  // from the snapshot header every tick, which would be a storage round trip per
  // user per tick to answer a question that only paces a timer.
  const lastRunAt = new Map<string, number>();

  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let running = false;

  const toEntry = (row: SnapshotSourceRow): SidecarEntry => ({
    id: row.id,
    sourcePath: row.sourcePath,
    filename: row.filename,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    contentHash: row.contentHash,
    title: row.title,
    titleIsUserEdited: row.titleIsUserEdited,
    tags: row.tags,
    starred: row.starred,
    starredAt: row.starredAt?.toISOString() ?? null,
    fileDate: row.fileDate?.toISOString() ?? null,
    bundles: row.bundles,
    reminders: row.reminders.map(r => ({
      title: r.title,
      note: r.note,
      dueAt: r.dueAt.toISOString(),
      remindAt: r.remindAt.toISOString(),
      timezone: r.timezone,
      rrule: r.rrule,
      remindOffsetDays: r.remindOffsetDays,
    })),
  });

  /**
   * Copies the current snapshot aside before a new one replaces it.
   *
   * Writing the new file in one piece prevents a half-written snapshot. It does
   * not protect against a faithful snapshot of data a bug has just erased,
   * which is what the previous copy is for.
   */
  const rotateBackup = async (userId: string): Promise<void> => {
    const current = await deps.storage.getObjectStream({ bucket: deps.bucket, key: snapshotKey(userId) });
    if (!current) return;
    await deps.storage.putObject({
      bucket: deps.bucket,
      key: snapshotBackupKey(userId),
      body: current.body,
      contentType: "application/x-ndjson",
    });
  };

  /**
   * Write one user's snapshot; null when mode is off or the probe matches disk.
   * Streams keyset pages straight into the storage write, so peak memory is one
   * page rather than one library.
   */
  const exportSnapshot = async (
    userId: string,
    opts?: { force?: boolean },
  ): Promise<SidecarExportResult | null> => {
    const mode = await deps.getMode(userId);
    if (mode === "off") return null;

    const probe = await deps.repository.changeProbe(userId);
    if (!opts?.force && lastProbe.get(userId) === probe.key) return null;

    const exportedAt = new Date();
    let entries = 0;
    let bytes = 0;

    const lines = async function* () {
      const emit = (line: string) => {
        bytes += Buffer.byteLength(line);
        return line;
      };
      yield emit(encodeHeader(userId, exportedAt, probe.mediaCount));
      yield emit(encodeTagLine(await deps.repository.listTags(userId)));

      let afterId: string | null = null;
      for (;;) {
        const page = await deps.repository.listExportPage(userId, afterId, EXPORT_PAGE);
        if (page.length === 0) break;
        for (const row of page) {
          // Neither match key: the reader drops this line (snapshotFormat's
          // toEntry), so writing it only costs bytes.
          if (!row.sourcePath && !row.contentHash) continue;
          entries += 1;
          yield emit(encodeEntry(toEntry(row)));
        }
        afterId = page[page.length - 1]!.id;
        if (page.length < EXPORT_PAGE) break;
      }
    };

    await rotateBackup(userId);
    await deps.storage.putObject({
      bucket: deps.bucket,
      key: snapshotKey(userId),
      body: Readable.from(lines()),
      contentType: "application/x-ndjson",
    });

    // Only after a successful write — a failed export must not mark the
    // database as already snapshotted.
    lastProbe.set(userId, probe.key);
    deps.logger.info({ userId, entries, bytes }, "sidecar: snapshot written");
    return { entries, bytes, exportedAt: exportedAt.toISOString() };
  };

  /**
   * What one snapshot entry may put back on the row it matched. Every field is
   * gated on the live row lacking it: the user may have edited in Vault since
   * the snapshot, and their newer value wins.
   */
  const planPatch = (entry: SidecarEntry, target: RestoreTargetRow): { patch: RestorePatch; tagsAdded: number } => {
    const patch: RestorePatch = { id: target.id };

    const missingTags = entry.tags.filter(tag => !target.tags.includes(tag));
    if (missingTags.length > 0) patch.tags = [...target.tags, ...missingTags];

    // An un-edited title was derived from the filename, so a rescan already
    // reproduced it.
    if (entry.titleIsUserEdited && !target.titleIsUserEdited && entry.title) {
      patch.title = entry.title;
      patch.titleIsUserEdited = true;
    }

    if (entry.starred && !target.starred) {
      patch.starred = true;
      patch.starredAt = entry.starredAt ? new Date(entry.starredAt) : new Date();
    }

    // A live fileDate came from the file's own EXIF/PDF metadata, at least as
    // trustworthy as the snapshot's.
    if (entry.fileDate && !target.fileDate) patch.fileDate = new Date(entry.fileDate);

    return { patch, tagsAdded: missingTags.length };
  };

  const restoreChunk = async (
    userId: string,
    entries: SidecarEntry[],
    result: SidecarRestoreResult,
  ): Promise<void> => {
    const sourcePaths = entries.map(e => e.sourcePath).filter((p): p is string => !!p);
    const contentHashes = entries.map(e => e.contentHash).filter((h): h is string => !!h);
    const targets = await deps.repository.findRestoreTargets(userId, sourcePaths, contentHashes);

    const byPath = new Map<string, RestoreTargetRow>();
    const byHash = new Map<string, RestoreTargetRow[]>();
    for (const target of targets) {
      if (target.sourcePath) byPath.set(target.sourcePath, target);
      if (target.contentHash) {
        const list = byHash.get(target.contentHash) ?? [];
        list.push(target);
        byHash.set(target.contentHash, list);
      }
    }

    const patches: RestorePatch[] = [];
    const bundleNames: string[] = [];
    const bundleLinks: Array<{ name: string; mediaId: string }> = [];
    const reminders: Array<Parameters<SidecarRepository["createReminders"]>[1][number]> = [];
    // A row must not be claimed twice in one chunk: two snapshot entries whose
    // paths both vanished would otherwise both land on the same hash match.
    const claimed = new Set<string>();

    for (const entry of entries) {
      let target = entry.sourcePath ? byPath.get(entry.sourcePath) : undefined;
      if (!target && entry.contentHash) {
        const candidates = (byHash.get(entry.contentHash) ?? []).filter(c => !claimed.has(c.id));
        // Duplicates are ordinary here, so a tie is a guess — one item's tags on
        // both copies is worse than leaving them off.
        if (candidates.length === 1) target = candidates[0];
      }
      if (!target || claimed.has(target.id)) continue;
      claimed.add(target.id);
      result.matched += 1;

      const { patch, tagsAdded } = planPatch(entry, target);
      if (Object.keys(patch).length > 1) {
        patches.push(patch);
        result.tagsRestored += tagsAdded;
      }

      for (const name of entry.bundles) {
        if (target.bundles.includes(name)) continue;
        bundleNames.push(name);
        bundleLinks.push({ name, mediaId: target.id });
      }

      // Reminders carry no stable identity, so a row that already has some
      // would just get duplicates.
      if (target.reminderCount === 0) {
        for (const r of entry.reminders) {
          reminders.push({
            mediaId: target.id,
            title: r.title,
            note: r.note,
            dueAt: new Date(r.dueAt),
            remindAt: new Date(r.remindAt || r.dueAt),
            timezone: r.timezone || "UTC",
            rrule: r.rrule,
            remindOffsetDays: r.remindOffsetDays,
          });
        }
      }
    }

    result.updated += await deps.repository.applyRestorePatches(patches);

    if (bundleLinks.length > 0) {
      const bundleIds = await deps.repository.ensureBundles(userId, bundleNames);
      const items = bundleLinks
        .map(link => ({ bundleId: bundleIds.get(link.name), mediaId: link.mediaId }))
        .filter((i): i is { bundleId: string; mediaId: string } => !!i.bundleId);
      result.bundlesRestored += await deps.repository.addBundleItems(items);
    }

    result.remindersRestored += await deps.repository.createReminders(userId, reminders);
  };

  /** Stream the snapshot and reattach everything it can. Idempotent: a second
   *  run finds nothing left to put back and reports `updated: 0`. */
  const restore = async (
    userId: string,
    onProgress?: (processed: number) => void,
  ): Promise<SidecarRestoreResult> => {
    const object = await deps.storage.getObjectStream({ bucket: deps.bucket, key: snapshotKey(userId) });
    if (!object) throw new Error("No snapshot to restore from");

    const result: SidecarRestoreResult = {
      entries: 0,
      matched: 0,
      updated: 0,
      tagsRestored: 0,
      bundlesRestored: 0,
      remindersRestored: 0,
      tagVocabularyRestored: 0,
    };

    let header = false;
    let chunk: SidecarEntry[] = [];

    for await (const line of readLines(object.body)) {
      if (!header) {
        // Throws before any row is touched, so a foreign or newer-schema file
        // aborts rather than half-applying.
        parseHeader(line);
        header = true;
        continue;
      }

      const parsed = parseLine(line);
      if (parsed.type === "tags") {
        result.tagVocabularyRestored += await deps.repository.restoreTagVocabulary(userId, parsed.tags);
        continue;
      }
      if (parsed.type !== "entry") continue;

      result.entries += 1;
      chunk.push(parsed.entry);
      if (chunk.length >= RESTORE_CHUNK) {
        await restoreChunk(userId, chunk, result);
        chunk = [];
        onProgress?.(result.entries);
      }
    }
    if (chunk.length > 0) await restoreChunk(userId, chunk, result);

    // Media.tags was rewritten in bulk, so every Tag.count is now a guess.
    await deps.reconcileTagCounts(userId);
    // The database no longer matches the snapshot this came from; let the next
    // tick write a fresh one rather than skipping on a stale probe.
    lastProbe.delete(userId);

    deps.logger.info({ userId, ...result }, "sidecar: restore complete");
    return result;
  };

  /**
   * Begins a restore and returns at once.
   *
   * A full library takes minutes, longer than a proxy will hold a request open,
   * so the outcome is read back through getStatus.
   */
  const startRestore = async (userId: string): Promise<{ started: boolean }> => {
    const startedAt = new Date().toISOString();
    if (!await deps.restoreStore.acquire(userId, { state: "running", startedAt, processed: 0 })) {
      return { started: false };
    }

    void restore(userId, processed => {
      // Not awaited: recording progress must not hold up the next chunk.
      void deps.restoreStore.heartbeat(userId, { state: "running", startedAt, processed });
    })
      // Two handlers rather than .then().catch(), so a failed write of a "done"
      // state cannot be mistaken for a failed restore.
      .then(
        result => deps.restoreStore.finish(userId, { state: "done", finishedAt: new Date().toISOString(), result }),
        (err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          deps.logger.error({ userId, err }, "sidecar: restore failed");
          return deps.restoreStore.finish(userId, { state: "failed", finishedAt: new Date().toISOString(), message });
        },
      )
      .catch((err: unknown) => {
        // The restore itself finished; this is Redis refusing to record the
        // outcome. The lock expires on its own and the restore is then reported
        // as interrupted, which is what a lost result should look like.
        deps.logger.error({ userId, err }, "sidecar: restore outcome not recorded");
      });

    return { started: true };
  };

  /** Reads the header line and stops — counting entries for real would stream
   *  the whole library on every settings-page load. */
  const getStatus = async (userId: string): Promise<SidecarStatus> => {
    const mode = await deps.getMode(userId);
    let snapshot: SidecarStatus["snapshot"] = null;

    const object = await deps.storage.getObjectStream({ bucket: deps.bucket, key: snapshotKey(userId) });
    if (object) {
      try {
        for await (const line of readLines(object.body)) {
          const header = parseHeader(line);
          snapshot = { exportedAt: header.exportedAt, entries: header.entries, sizeBytes: object.contentLength ?? 0 };
          break;
        }
      } catch (err) {
        // Reported as though there were no snapshot, rather than failing the
        // settings page.
        deps.logger.warn({ userId, err }, "sidecar: existing snapshot is unreadable");
      } finally {
        object.body.destroy();
      }
    }

    return { enabled: true, mode, snapshot, restore: await deps.restoreStore.read(userId) };
  };

  /**
   * One export pass over every user. Never throws — see derivativeFeeder.
   *
   * The timer is process-wide, so a user's own interval is enforced by skipping
   * them here rather than by changing the tick rate. An empty map after a
   * restart means one export on the first tick, which is correct and cheap.
   */
  const tick = async (): Promise<void> => {
    const userIds = await deps.listUserIds();
    const now = Date.now();
    for (const userId of userIds) {
      // A restore is rewriting rows right now. Exporting would write a
      // half-restored library over the file being read.
      // half-restored library over the file being read.
      if (await deps.restoreStore.isRunning(userId)) continue;

      const last = lastRunAt.get(userId);
      if (last !== undefined) {
        const gapMs = (await deps.getIntervalMinutes(userId).catch(() => 5)) * 60_000;
        if (now - last < gapMs) continue;
      }

      lastRunAt.set(userId, now);
      try {
        await exportSnapshot(userId);
      } catch (err) {
        deps.logger.error({ userId, err }, "sidecar: export failed");
      }
    }
  };

  const runOnce = async () => {
    if (running || stopped) return;
    running = true;
    try {
      await tick();
    } catch (err) {
      deps.logger.error({ err }, "sidecar: tick failed");
    } finally {
      running = false;
      if (!stopped) {
        timer = setTimeout(() => void runOnce(), intervalMs);
        timer.unref?.();
      }
    }
  };

  return {
    exportSnapshot,
    restore,
    startRestore,
    getStatus,
    tick,
    start () {
      if (timer || stopped) return;
      void runOnce();
    },
    async stop () {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}
