import { lstat } from "node:fs/promises";
import type { Job, Processor } from "bullmq";
import type { ReconcileJobData, ReconcileJobProgress } from "../queues/enqueueReconcile.js";
import type {
  MediaRepository,
  MoveCandidateRow,
  ReconcileEntry,
} from "../repositories/mediaRepository.js";
import { assertUnderAllowedRoot, canonicalizeAbsPath } from "../lib/media/indexRoots.js";
import { normalizeExtensions } from "../lib/media/extensions.js";
import { matchIdentity } from "../lib/media/matchIdentity.js";
import { sameMtime } from "../lib/media/sourceMtime.js";
import { hashFileStreaming } from "../lib/media/hashFile.js";
import { deriveTitle } from "../lib/media/deriveTitle.js";
import { walkFiles, type WalkFilters, type WalkStats } from "./indexWalk.js";
import {
  type DiscoveredFile,
  type IndexCoreDeps,
  indexFiles,
  planDerivations,
} from "./indexCore.js";

type ReconcileLogger = {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
  error: (obj: object, msg: string) => void;
};

/** The parts of a stat this worker reads. The type predicates are optional, so
 *  a stub can return only `{ size, mtimeMs }`. */
type StatLike = {
  size: number;
  mtimeMs?: number;
  isDirectory?: () => boolean;
  isSymbolicLink?: () => boolean;
};

export type ReconcileWorkerDeps = IndexCoreDeps & {
  mediaRepository: MediaRepository;
  logger: ReconcileLogger;
  /** Stats one source file. Defaults to fs.lstat. */
  statFile?: (absPath: string) => Promise<StatLike>;
  /** Hashes a file, to break a tie between move candidates. */
  hashFile?: (absPath: string) => Promise<string | null>;
  /** Lists the files on disk under a root. Defaults to the shared walk. */
  walkRoot?: (root: string, filters: WalkFilters, stats: WalkStats) => AsyncGenerator<DiscoveredFile>;
  /**
   * Reads the current abort epoch. Reconcile keeps a counter of its own, so
   * stopping a sweep does not stop an index scan. Absent, a sweep never aborts.
   */
  readAbortEpoch?: () => Promise<number>;
  batchSize?: number;
};

/** How many newly-discovered files are written to the database at a time. */
const BATCH_SIZE = 200;
/** Cap on ids per tombstone/revive UPDATE, mirroring the watcher's batching. */
const UPDATE_BATCH_SIZE = 500;
/** Minimum gap between progress publishes / abort re-reads, in ms. */
const TICK_MS = 250;

/**
 * Reconciles one indexing root: a two-way comparison between the library and the
 * disk. It is the only thing that sees drift, because the watcher observes
 * events only while the process runs, and an index scan skips a path that
 * already has a row.
 *
 * docs/OVERVIEW.md describes both passes in full. The invariants the code below
 * rests on are commented where they apply.
 */
export function createReconcileProcessor (deps: ReconcileWorkerDeps): Processor<ReconcileJobData> {
  const statFile = deps.statFile ?? (async (p: string) => lstat(p));
  const hashFile = deps.hashFile ?? hashFileStreaming;
  const walkRoot = deps.walkRoot ?? walkFiles;

  return async (job: Job<ReconcileJobData>) => {
    const { userId, allowedRoots } = job.data;
    // allowedRoots is snapshotted at enqueue time — a queued path is never
    // trusted without it. This also returns the canonical form the rows store.
    const root = assertUnderAllowedRoot(job.data.rootPath, allowedRoots);
    const filters: WalkFilters = {
      recursive: true, // a depth-limited reconcile would tombstone everything deeper
      ignoreHidden: job.data.ignoreHidden,
      blacklist: normalizeExtensions(job.data.blacklistExtensions),
      excludeFolders: job.data.excludeFolders ?? [],
      skipNonContent: job.data.skipNonContent ?? true,
    };

    const batchSize = deps.batchSize ?? BATCH_SIZE;
    const readAbortEpoch = deps.readAbortEpoch ?? (async () => 0);
    // Capture once at start; a later bump means a stop was requested after this
    // sweep began. Re-read on a tick rather than per row, to bound the Redis hits.
    const startEpoch = await readAbortEpoch();
    const isAborted = async () => (await readAbortEpoch()) > startEpoch;

    const progress: ReconcileJobProgress = {
      checked: 0, scanned: 0, added: 0, moved: 0, revived: 0, missing: 0, changed: 0,
    };
    let lastTickAt = 0;
    const tick = async (): Promise<boolean> => {
      const now = Date.now();
      if (now - lastTickAt < TICK_MS) return false;
      lastTickAt = now;
      await job.updateProgress(progress);
      return isAborted();
    };

    deps.logger.info({ userId, root }, "reconcile started");
    let aborted = false;

    // Library to disk: is every row's file still there, and still the same?
    const rows = await deps.mediaRepository.listReconcileEntries(userId, root);
    // Keyed by the stored (already canonical) sourcePath so the walk below can
    // ask "do I already know this file?" without a query per file.
    const known = new Set(rows.map(r => r.sourcePath));

    const vanished: string[] = [];
    const returned: string[] = [];

    /**
     * The bytes at a known path changed under us. Record the new size/mtime,
     * invalidate everything derived from the old bytes, and reset the states
     * a first index would have set for this type and size — the
     * derivative feeder (thumb, text, hash) claims from there.
     */
    const reprocessChanged = async (row: ReconcileEntry, size: number, mtimeMs: number | null) => {
      const plan = planDerivations(row.mimeType, size);
      // fileDate moves on only while it is still the file's modified time. Once
      // the thumbnail worker has replaced it with a date read from inside the
      // file, that one is better and must not be overwritten. The re-queued
      // thumbnail job refreshes it if the embedded date changed too.
      const fileDateWasMtime =
        row.fileDate === null ||
        (row.mtimeMs !== null && row.fileDate.getTime() === Math.trunc(row.mtimeMs));
      const fileDate = fileDateWasMtime && mtimeMs !== null ? new Date(mtimeMs) : undefined;

      await deps.mediaRepository.applySourceChanged(userId, row.id, {
        sizeBytes: size,
        mtimeMs,
        resetThumb: plan.thumb,
        resetText: plan.text,
        resetHash: plan.hash,
        ...(fileDate ? { fileDate } : {}),
      });
    };

    for (const row of rows) {
      if (await tick()) { aborted = true; break; }

      const st = await statFile(row.sourcePath).catch(() => null);
      progress.checked++;

      // Gone, in every sense that matters to the row pointing here: deleted, or
      // replaced by a directory, or replaced by a symlink. The walk never yields
      // a symlink (see indexWalk), so reconcile must not keep treating one as a
      // live source either — `openSourceStream` validates the stored path but
      // then follows the link, which could read outside the allowed roots.
      if (!st || st.isDirectory?.() || st.isSymbolicLink?.()) {
        if (row.missingSince === null) vanished.push(row.id);
        continue;
      }

      const mtimeMs = st.mtimeMs ?? null;
      // mtime only counts as a signal when both sides know it; size alone still
      // catches an edit on a row that predates the sourceMtimeMs column.
      const changed =
        row.sizeBytes !== st.size ||
        (row.mtimeMs !== null && mtimeMs !== null && !sameMtime(row.mtimeMs, mtimeMs));

      if (changed) {
        await reprocessChanged(row, st.size, mtimeMs);
        progress.changed++;
        // A changed row may also have been tombstoned (the file was missing last
        // sweep and came back edited). applySourceChanged clears that, but the
        // move/revive publish below won't fire for it, so tell open views here
        // or the item stays flagged missing until a manual refresh.
        if (row.missingSince !== null) {
          deps.publishJobUpdate?.({ userId, mediaId: row.id, field: "mediaMoved", value: "1" });
        }
      } else {
        if (row.missingSince !== null) returned.push(row.id);
        // The file matched what we had recorded, but the *record* may be
        // incomplete: rows predating these columns have them NULL. Heal both
        // from the stat already in hand — the mtime so later sweeps and move
        // detection have something to compare, the fileDate because reconcile
        // replaced the periodic index scan that used to backfill it. Not a
        // change: nothing was re-derived, so it stays out of the counters.
        const healMtime = row.mtimeMs === null && mtimeMs !== null;
        const healFileDate = row.fileDate === null && mtimeMs !== null && mtimeMs > 0;
        if (healMtime || healFileDate) {
          await deps.mediaRepository.healSourceMetadata(userId, row.id, {
            ...(healMtime ? { mtimeMs } : {}),
            ...(healFileDate ? { fileDate: new Date(mtimeMs!) } : {}),
          });
        }
      }
    }

    // Tombstone rather than delete: the file may have moved, or the drive may
    // simply be unmounted. Only the missing-sweeper in worker/index.ts deletes,
    // and only once the grace period has passed.
    //
    // Skipped entirely on abort. The pass that recognises a tombstone as a move
    // never runs when aborted, while the sweeper still deletes once the grace
    // period lapses, so tombstoning here would let a cancelled sweep destroy
    // rows for files that had only moved.
    if (!aborted) {
      for (let i = 0; i < vanished.length; i += UPDATE_BATCH_SIZE) {
        progress.missing += await deps.mediaRepository.markMissing(
          userId, vanished.slice(i, i + UPDATE_BATCH_SIZE),
        );
      }
      if (progress.missing > 0) {
        deps.publishJobUpdate?.({
          userId, mediaId: "*", field: "mediaMissing", value: String(progress.missing),
        });
      }
    }

    // Revivals are safe to keep on abort: unlike a tombstone, this only un-marks
    // rows whose file we positively saw on disk, and it can never lead to a
    // deletion. A file back at its original path (drive remounted, deletion
    // undone) simply stops being flagged.
    for (let i = 0; i < returned.length; i += UPDATE_BATCH_SIZE) {
      await deps.mediaRepository.clearMissing(userId, returned.slice(i, i + UPDATE_BATCH_SIZE));
    }
    progress.revived = returned.length;

    // Disk to library: is every file on disk in the library?
    //
    // Every tombstone the sweeper has not yet taken is a move candidate, not just
    // the recent ones the watcher considers: the file may have moved days ago
    // while Vault was off, so the only meaningful bound is the grace period.
    // Deliberately not scoped to this root, so a move between roots matches.
    //
    // Bucketed by size, because that pool is unbounded and `matchIdentity`
    // reports `ambiguous` whenever *any* candidate carries a contentHash — so
    // unbucketed, one hashed tombstone anywhere forces a full byte-read of every
    // new file in the sweep. Sound as well as fast: a move preserves size
    // exactly, and equal hashes imply equal size.
    const candidatesBySize = new Map<number, MoveCandidateRow[]>();
    if (!aborted) {
      for (const c of await deps.mediaRepository.findMoveCandidates(userId, new Date(0))) {
        const bucket = candidatesBySize.get(c.sizeBytes);
        if (bucket) bucket.push(c);
        else candidatesBySize.set(c.sizeBytes, [c]);
      }
    }

    /**
     * Tries to explain a file with no row as an item that moved. It hashes only
     * to break a real tie among same-size candidates: hashing every unmatched
     * file would take far longer than the re-index this avoids. A candidate
     * that matches leaves its bucket, so two files cannot claim one row.
     */
    const rematch = async (file: DiscoveredFile, canonical: string): Promise<boolean> => {
      const bucket = candidatesBySize.get(file.size);
      if (!bucket || bucket.length === 0) return false;

      const incoming = { basename: file.name, sizeBytes: file.size, mtimeMs: file.mtimeMs ?? null };
      let result = matchIdentity(incoming, bucket);
      if (result.kind === "ambiguous") {
        const contentHash = await hashFile(file.absPath);
        result = contentHash
          ? matchIdentity({ ...incoming, contentHash }, result.candidates)
          : { kind: "none" };
      }
      if (result.kind !== "matched") return false;

      const matched = result.candidate;
      await deps.mediaRepository.applyMove(userId, matched.id, {
        sourcePath: canonical,
        filename: file.name,
        sizeBytes: file.size,
        mtimeMs: file.mtimeMs ?? null,
        // A title the user typed is theirs to keep; an auto-derived one follows
        // the new filename.
        ...(matched.titleIsUserEdited ? {} : { title: deriveTitle(file.name) }),
      });
      // Deliberately no thumb/OCR re-enqueue: size and mtime (or the hash)
      // matched, so the bytes are unchanged and the derivatives still correct.
      const idx = bucket.findIndex(c => c.id === matched.id);
      if (idx >= 0) bucket.splice(idx, 1);

      deps.logger.info(
        { userId, mediaId: matched.id, path: canonical, via: result.via },
        "reconcile: matched moved file to existing item",
      );
      return true;
    };

    const walkStats: WalkStats = { filtered: 0 };
    let batch: DiscoveredFile[] = [];
    const flushNew = async () => {
      if (batch.length === 0) return;
      const { indexed } = await indexFiles(deps, userId, batch, allowedRoots);
      progress.added += indexed;
      batch = [];
      await job.updateProgress(progress);
    };

    if (!aborted) {
      for await (const file of walkRoot(root, filters, walkStats)) {
        progress.scanned++;
        if (await tick()) { aborted = true; break; }

        const canonical = canonicalizeAbsPath(file.absPath);
        if (known.has(canonical)) continue; // already settled by the pass above

        // No row for this path. Before creating one, check whether this is a
        // file we already know that moved — indexing it fresh is what would
        // destroy the user's tags, title, starred state, bundles and text.
        if (candidatesBySize.size > 0 && (await rematch(file, canonical))) {
          progress.moved++;
          continue;
        }

        batch.push(file);
        if (batch.length >= batchSize) {
          // Check before flushing so an aborted sweep doesn't insert the batch in hand.
          if (await isAborted()) { aborted = true; break; }
          await flushNew();
        }
      }
    }
    if (!aborted && (await isAborted())) aborted = true;
    if (!aborted) await flushNew();

    const relocated = progress.moved + progress.revived;
    if (relocated > 0) {
      deps.publishJobUpdate?.({ userId, mediaId: "*", field: "mediaMoved", value: String(relocated) });
    }

    if (aborted) progress.aborted = true;
    await job.updateProgress(progress);
    deps.logger[aborted ? "warn" : "info"](
      { userId, root, ...progress, filtered: walkStats.filtered },
      aborted ? "reconcile aborted" : "reconcile completed",
    );
    return progress;
  };
}
