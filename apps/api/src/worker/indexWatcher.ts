import path from "node:path";
import { lstat } from "node:fs/promises";
import chokidar, { type FSWatcher } from "chokidar";
import type { IndexConfig } from "../services/preferencesService.js";
import type { MediaRepository } from "../repositories/mediaRepository.js";
import { isUnderAllowedRoot, isExcludedFolder, canonicalizeAbsPath } from "../lib/media/indexRoots.js";
import { normalizeExtensions } from "../lib/media/extensions.js";
import { isBuildDir, isNonContentFile, isJunkDir, isJunkFile } from "../lib/media/contentFilters.js";
import { matchIdentity, type IncomingFile } from "../lib/media/matchIdentity.js";
import { hashFileStreaming } from "../lib/media/hashFile.js";
import { deriveTitle } from "../lib/media/deriveTitle.js";
import { type IndexCoreDeps, indexFiles, isBlacklisted } from "./indexCore.js";

/**
 * Keeps the library in step with the filesystem while the process runs: a new
 * file is indexed, a deleted one is tombstoned, and a changed one has its
 * thumbnail refreshed.
 *
 * It is best-effort. On bind mounts and network shares the operating system may
 * report nothing at all, even with polling on, so the periodic reconcile sweep
 * is the authority. Configs are re-read on an interval, so adding or removing a
 * root takes effect without a restart.
 */

/** Cap on ids per tombstone UPDATE, so moving a directory of 100k files does
 *  not build a single unbounded `IN` list. Mirrors the scan's batching. */
const MISSING_BATCH_SIZE = 500;

type WatchLogger = {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
  error: (obj: object, msg: string) => void;
};

/** The parts of a stat these handlers read. The type predicates are optional,
 *  so a stub can return only `{ size }`. */
type StatLike = { size: number; mtimeMs?: number; isDirectory?: () => boolean; isSymbolicLink?: () => boolean };

export type IndexWatcherDeps = IndexCoreDeps & {
  mediaRepository: MediaRepository;
  /** Delete a Media row + its derived storage objects (mediaActionsService.deleteMedia). */
  deleteMedia: (userId: string, id: string) => Promise<unknown>;
  /** Re-derive a thumbnail for an already-indexed item (mediaActionsService.regenerateThumbnail).
   *  Carries allowedRoots so the worker can re-validate an in-place source read. */
  regenerateThumbnail: (userId: string, id: string, allowedRoots: string[]) => Promise<unknown>;
  logger: WatchLogger;
  /** Stats a file on `add`. Defaults to fs.lstat. */
  statFile?: (absPath: string) => Promise<StatLike>;
  /** Hashes a file to break a tie between move candidates, and is called only
   *  when the cheap signals were inconclusive. Returns null when the file
   *  cannot be read. */
  hashFile?: (absPath: string) => Promise<string | null>;
  /** Current time in epoch ms — injectable so tests can drive the
   *  move-detection window without sleeping. */
  now?: () => number;
};

/** First config whose allowed roots contain `absPath` (single-user in practice). */
function resolveConfig (absPath: string, configs: IndexConfig[]): IndexConfig | null {
  return configs.find(c => isUnderAllowedRoot(absPath, c.allowedRoots)) ?? null;
}

/** True if this path should never be indexed under the given config (hidden /
 *  excluded folder / blacklisted extension) — mirrors the scan's walk() rules. */
function isFiltered (absPath: string, config: IndexConfig): boolean {
  const base = path.basename(absPath);
  if (config.ignoreHidden && base.startsWith(".")) return true;
  if (isExcludedFolder(absPath, config.excludeFolders)) return true;
  if (isJunkFile(base)) return true; // OS metadata / temp / backup artifacts — never content
  if (isBlacklisted(base, normalizeExtensions(config.blacklistExtensions))) return true;
  if (config.skipNonContent && isNonContentFile(base)) return true;
  return false;
}

/**
 * Applies events one at a time, in the order they arrived.
 *
 * Move detection reads and writes the same tombstones from both the `unlink`
 * and the `add` handler, and chokidar fires the two at once. Interleaved, the
 * halves of a move are missed or applied twice. A rejection is contained, so
 * one failed event does not stop the rest.
 */
function createSerialQueue (): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };
}

/**
 * The filesystem-event handlers, kept apart from chokidar itself. `getConfigs`
 * is read afresh on every event, so a settings change takes effect without the
 * handlers being rewired. They are serialized against each other; see
 * {@link createSerialQueue}.
 */
export function createIndexEventHandlers (deps: IndexWatcherDeps, getConfigs: () => IndexConfig[]) {
  const statFile = deps.statFile ?? (async (p: string) => lstat(p));
  const hashFile = deps.hashFile ?? hashFileStreaming;
  const now = deps.now ?? (() => Date.now());

  /** Start of the window in which a vanished file may still turn up elsewhere
   *  and be recognised as the same item. */
  const moveWindowStart = (config: IndexConfig): Date =>
    new Date(now() - config.moveDetectionWindowSeconds * 1000);

  /**
   * Try to explain a newly-appeared file as an already-known item that moved or
   * was renamed. Returns true when it did, meaning the caller must not index it
   * as new. It hashes only to break a real tie: hashing every added file would
   * take longer than the re-index this avoids.
   */
  const rematchMovedFile = async (
    config: IndexConfig,
    absPath: string,
    incoming: IncomingFile,
  ): Promise<boolean> => {
    const candidates = await deps.mediaRepository.findMoveCandidates(
      config.userId,
      moveWindowStart(config),
    );
    // The overwhelmingly common case: nothing recently went missing, so this is
    // simply a new file and we have done one indexed lookup to find that out.
    if (candidates.length === 0) return false;

    let result = matchIdentity(incoming, candidates);
    if (result.kind === "ambiguous") {
      const contentHash = await hashFile(absPath);
      result = contentHash
        ? matchIdentity({ ...incoming, contentHash }, result.candidates)
        : { kind: "none" };
    }
    if (result.kind !== "matched") return false;

    const matched = result.candidate;
    await deps.mediaRepository.applyMove(config.userId, matched.id, {
      sourcePath: canonicalizeAbsPath(absPath),
      filename: incoming.basename,
      sizeBytes: incoming.sizeBytes,
      mtimeMs: incoming.mtimeMs,
      // A title the user typed is theirs to keep; an auto-derived one should
      // follow the new filename.
      ...(matched.titleIsUserEdited ? {} : { title: deriveTitle(incoming.basename) }),
    });
    // Deliberately no thumb/OCR re-enqueue: the bytes did not change, so the
    // existing thumbnail and extracted text are still correct.
    deps.publishJobUpdate?.({
      userId: config.userId, mediaId: matched.id, field: "mediaMoved", value: "1",
    });
    deps.logger.info(
      { userId: config.userId, mediaId: matched.id, path: absPath, via: result.via },
      "watch: matched moved file to existing item",
    );
    return true;
  };

  const onAdd = async (absPath: string): Promise<void> => {
    try {
      const config = resolveConfig(absPath, getConfigs());
      if (!config || isFiltered(absPath, config)) return;
      let st: StatLike;
      try {
        st = await statFile(absPath);
      } catch {
        return; // vanished between the event and the stat — nothing to index
      }
      // Mirror walk(): never index a directory (chokidar emits `add` for dirs too)
      // or a followed symlink, and skip empty placeholders.
      if (st.isDirectory?.() || st.isSymbolicLink?.()) return;
      if (st.size === 0) return;
      const name = path.basename(absPath);
      const canonical = canonicalizeAbsPath(absPath);
      const atSamePath = await deps.mediaRepository.findIdentityBySourcePath(config.userId, canonical);

      // A tombstoned row at this exact path means the file came back where it was
      // (drive remounted, deletion undone). Must be handled before move matching:
      // the bytes may differ from what we last saw, so no identity match would
      // fire and the row would stay missing forever while `indexFiles` skipped
      // the path as already-indexed.
      if (atSamePath?.missingSince) {
        await deps.mediaRepository.applyMove(config.userId, atSamePath.id, {
          sourcePath: canonical,
          filename: name,
          sizeBytes: st.size,
          mtimeMs: st.mtimeMs ?? null,
        });

        await deps.regenerateThumbnail(config.userId, atSamePath.id, config.allowedRoots);
        deps.publishJobUpdate?.({
          userId: config.userId, mediaId: atSamePath.id, field: "mediaMoved", value: "1",
        });
        deps.logger.info({ userId: config.userId, path: absPath }, "watch: missing file reappeared");
        return;
      }

      // Is this a file we already know, that simply moved? Indexing it fresh
      // would destroy the user's tags, title, starred state, bundles, reminders
      // and extracted text. A live row already on this path rules a move out.
      if (!atSamePath) {
        const moved = await rematchMovedFile(config, absPath, {
          basename: name,
          sizeBytes: st.size,
          mtimeMs: st.mtimeMs ?? null,
        });
        if (moved) return;
      }

      const file = { absPath, name, size: st.size, mtimeMs: st.mtimeMs };
      const { indexed } = await indexFiles(deps, config.userId, [file], config.allowedRoots);
      if (indexed > 0) deps.logger.info({ userId: config.userId, path: absPath }, "watch: indexed new file");
    } catch (err) {
      deps.logger.error({ err, path: absPath }, "watch: add handler failed");
    }
  };

  const onChange = async (absPath: string): Promise<void> => {
    try {
      const config = resolveConfig(absPath, getConfigs());
      if (!config || isFiltered(absPath, config)) return;
      // Canonical form is what indexFiles stored — on Windows that includes an
      // upper-cased drive letter, which a raw resolve does not guarantee.
      const id = await deps.mediaRepository.findIdBySourcePath(config.userId, canonicalizeAbsPath(absPath));
      if (!id) return void (await onAdd(absPath)); // changed before we ever saw an add
      // Refreshes the thumbnail for the edited bytes. Text is not re-extracted
      // on a change: that needs an enqueue that carries the allow-list, which
      // this path does not have.
      await deps.regenerateThumbnail(config.userId, id, config.allowedRoots);
      deps.logger.info({ userId: config.userId, path: absPath }, "watch: refreshed changed file");
    } catch (err) {
      deps.logger.error({ err, path: absPath }, "watch: change handler failed");
    }
  };

  /**
   * Handles the reverse event order: on some platforms, and across
   * filesystems, a move's `add` arrives before its `unlink`. By then a bare new
   * row already exists for the destination, holding none of the user's
   * metadata. The vanished row is moved onto that path and the bare one
   * deleted, so the row that survives is the one with the history and the id.
   *
   * Returns true when the disappearance was resolved as a move.
   */
  const adoptAlreadyIndexedTarget = async (
    config: IndexConfig,
    vanished: { id: string; basename: string; sizeBytes: number; mtimeMs: number | null; contentHash: string | null; titleIsUserEdited: boolean },
  ): Promise<boolean> => {
    const recent = await deps.mediaRepository.findRecentlyIndexed(
      config.userId,
      moveWindowStart(config),
    );
    const targets = recent.filter(r => r.id !== vanished.id);
    if (targets.length === 0) return false;

    // The file is gone, so there is nothing left to hash — an unresolved tie
    // just falls through to a tombstone, which loses nothing.
    const result = matchIdentity(vanished, targets);
    if (result.kind !== "matched") return false;

    const target = result.candidate;
    // Order matters: the bare row occupies (userId, sourcePath), so it has to go
    // before the surviving row can take that path. deleteMedia also clears the
    // thumbnail it may already have derived.
    await deps.deleteMedia(config.userId, target.id);
    await deps.mediaRepository.applyMove(config.userId, vanished.id, {
      sourcePath: target.sourcePath,
      filename: target.filename,
      sizeBytes: target.sizeBytes,
      mtimeMs: target.mtimeMs,
      ...(vanished.titleIsUserEdited ? {} : { title: deriveTitle(target.filename) }),
    });
    deps.publishJobUpdate?.({
      userId: config.userId, mediaId: vanished.id, field: "mediaMoved", value: "1",
    });
    deps.logger.info(
      { userId: config.userId, mediaId: vanished.id, absorbed: target.id, via: result.via },
      "watch: reclaimed moved item indexed out of order",
    );
    return true;
  };

  const onUnlink = async (absPath: string): Promise<void> => {
    try {
      for (const config of getConfigs()) {
        if (!isUnderAllowedRoot(absPath, config.allowedRoots)) continue;
        const vanished = await deps.mediaRepository.findIdentityBySourcePath(
          config.userId,
          canonicalizeAbsPath(absPath),
        );
        if (!vanished) continue;

        if (await adoptAlreadyIndexedTarget(config, vanished)) continue;

        // Not (yet) explained as a move. Tombstone rather than delete: the
        // matching `add` may still be in flight, the drive may just be
        // unmounted, and everything the user attached to this item is
        // irreplaceable. The sweeper deletes it for real once the grace period
        // passes without the file coming back.
        const marked = await deps.mediaRepository.markMissing(config.userId, [vanished.id]);
        if (marked > 0) {
          deps.publishJobUpdate?.({
            userId: config.userId, mediaId: vanished.id, field: "mediaMissing", value: "1",
          });
          deps.logger.info({ userId: config.userId, path: absPath }, "watch: marked file missing");
        }
      }
    } catch (err) {
      deps.logger.error({ err, path: absPath }, "watch: unlink handler failed");
    }
  };

  const onUnlinkDir = async (absPath: string): Promise<void> => {
    try {
      for (const config of getConfigs()) {
        if (!isUnderAllowedRoot(absPath, config.allowedRoots)) continue;
        const ids = await deps.mediaRepository.findIdsBySourcePathPrefix(
          config.userId,
          canonicalizeAbsPath(absPath),
        );
        if (ids.length === 0) continue;
        // Tombstone the whole subtree in one pass; the `add` storm that follows
        // a directory move then rematches each file individually.
        let marked = 0;
        for (let i = 0; i < ids.length; i += MISSING_BATCH_SIZE) {
          marked += await deps.mediaRepository.markMissing(
            config.userId,
            ids.slice(i, i + MISSING_BATCH_SIZE),
          );
        }
        if (marked > 0) {
          deps.publishJobUpdate?.({
            userId: config.userId, mediaId: "*", field: "mediaMissing", value: String(marked),
          });
          deps.logger.info(
            { userId: config.userId, path: absPath, count: marked },
            "watch: marked folder contents missing",
          );
        }
      }
    } catch (err) {
      deps.logger.error({ err, path: absPath }, "watch: unlinkDir handler failed");
    }
  };

  // Every handler goes through one queue so the two halves of a move are applied
  // in a deterministic order no matter which the OS reports first.
  const serial = createSerialQueue();
  return {
    onAdd: (p: string) => serial(() => onAdd(p)),
    onChange: (p: string) => serial(() => onChange(p)),
    onUnlink: (p: string) => serial(() => onUnlink(p)),
    onUnlinkDir: (p: string) => serial(() => onUnlinkDir(p)),
  };
}

export type IndexWatcher = {
  start: () => Promise<void>;
  close: () => Promise<void>;
};

export type CreateIndexWatcherOptions = {
  /** Use polling instead of native inotify. Required on Docker Desktop / WSL2
   *  bind mounts and network shares, where host changes don't emit inotify. */
  polling?: boolean;
  /** Polling interval (ms) when polling is on. */
  interval?: number;
  /** How often to re-read user configs and re-sync watched roots (ms). */
  resyncIntervalMs?: number;
};

export function createIndexWatcher (
  deps: IndexWatcherDeps,
  loadConfigs: () => Promise<IndexConfig[]>,
  options: CreateIndexWatcherOptions = {},
): IndexWatcher {
  const polling = options.polling ?? false;
  const interval = options.interval ?? 2000;
  const resyncIntervalMs = options.resyncIntervalMs ?? 15_000;

  let configs: IndexConfig[] = [];
  let watcher: FSWatcher | null = null;
  let watched = new Set<string>();
  let resyncTimer: NodeJS.Timeout | null = null;

  const handlers = createIndexEventHandlers(deps, () => configs);

  const rootsFromConfigs = (cfgs: IndexConfig[]): Set<string> => {
    const roots = new Set<string>();
    for (const c of cfgs) for (const r of c.allowedRoots) roots.add(path.resolve(r));
    return roots;
  };

  // chokidar's `ignored` predicate: skip hidden / excluded paths up front so the
  // watcher never descends into them. The extension blacklist is enforced in the
  // add handler instead (it can't be told dir-vs-file reliably here).
  const ignored = (p: string): boolean => {
    const config = resolveConfig(p, configs);
    if (!config) return false; // a watched root itself, or a path we can't classify
    const base = path.basename(p);
    if (config.ignoreHidden && base.startsWith(".")) return true;
    if (isExcludedFolder(p, config.excludeFolders)) return true;
    if (isJunkDir(base)) return true; // $RECYCLE.BIN, System Volume Information, .Trash — never descend
    // Skip dependency/build dirs wholesale — chokidar won't descend into an
    // ignored directory, so node_modules etc. are never watched.
    if (config.skipNonContent && isBuildDir(base)) return true;
    return false;
  };

  const syncRoots = async (): Promise<void> => {
    configs = await loadConfigs();
    const next = rootsFromConfigs(configs);
    if (!watcher) return;
    for (const root of next) if (!watched.has(root)) watcher.add(root);
    for (const root of watched) if (!next.has(root)) watcher.unwatch(root);
    watched = next;
  };

  const start = async (): Promise<void> => {
    configs = await loadConfigs();
    watched = rootsFromConfigs(configs);

    watcher = chokidar.watch([...watched], {
      ignoreInitial: true, // startup backfill is the reconciliation scan's job
      persistent: true,
      followSymlinks: false, // mirrors walk(): never follow symlinks
      usePolling: polling,
      interval,
      binaryInterval: interval,
      awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 200 },
      ignored,
    });

    watcher.on("add", p => void handlers.onAdd(path.resolve(p)));
    watcher.on("change", p => void handlers.onChange(path.resolve(p)));
    watcher.on("unlink", p => void handlers.onUnlink(path.resolve(p)));
    watcher.on("unlinkDir", p => void handlers.onUnlinkDir(path.resolve(p)));
    watcher.on("error", err => deps.logger.error({ err }, "watch: chokidar error"));
    watcher.on("ready", () =>
      deps.logger.info({ roots: [...watched], polling }, "index watcher ready"),
    );

    resyncTimer = setInterval(() => void syncRoots().catch(err =>
      deps.logger.warn({ err }, "watch: config re-sync failed"),
    ), resyncIntervalMs);
  };

  const close = async (): Promise<void> => {
    if (resyncTimer) clearInterval(resyncTimer);
    if (watcher) await watcher.close();
    watcher = null;
  };

  return { start, close };
}
