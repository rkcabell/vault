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

/** Cap on ids per tombstone UPDATE, so moving a directory of 100k files does
 *  not build a single unbounded `IN` list. Mirrors the scan's batching. */
const MISSING_BATCH_SIZE = 500;

type WatchLogger = {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
  error: (obj: object, msg: string) => void;
};

/** A minimal stat — injectable so handler tests don't touch the real FS. The
 *  type predicates are optional so test stubs can return just `{ size }`. */
type StatLike = { size: number; mtimeMs?: number; isDirectory?: () => boolean; isSymbolicLink?: () => boolean };

export type IndexWatcherDeps = IndexCoreDeps & {
  mediaRepository: MediaRepository;
  /** Delete a Media row + its derived storage objects (mediaActionsService.deleteMedia). */
  deleteMedia: (userId: string, id: string) => Promise<unknown>;
  /** Re-derive a thumbnail for an already-indexed item (mediaActionsService.regenerateThumbnail).
   *  Carries allowedRoots so the worker can re-validate an in-place source read. */
  regenerateThumbnail: (userId: string, id: string, allowedRoots: string[]) => Promise<unknown>;
  logger: WatchLogger;
  /** Override the file stat used on `add` — defaults to fs.lstat. Test seam. */
  statFile?: (absPath: string) => Promise<StatLike>;
  /** Stream-hash a file to break a tie between move candidates. Only called
   *  when cheap metadata was inconclusive. Defaults to a streaming sha256;
   *  returns null if the file cannot be read. Test seam. */
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
 * Serialize async work so events are applied one at a time in arrival order.
 *
 * Move detection reads and writes the same tombstone set from both the `unlink`
 * and `add` handlers, and chokidar fires them concurrently. Without this, the
 * two halves of a move can interleave — both sides observing a state neither
 * has finished writing — and a rematch is missed or applied twice. Rejections
 * are contained so one failed event cannot poison the rest of the chain.
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
 * The filesystem-event handlers, decoupled from chokidar so they can be unit
 * tested with injected deps + a fake config list. `getConfigs` is read fresh on
 * every event so settings changes (re-synced by the watcher) take effect without
 * re-wiring handlers.
 *
 * The handlers returned here are serialized against each other — see
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
   * as new. Hashing happens only to break a genuine tie — hashing every added
   * file would cost more than the re-index this exists to avoid.
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

      // A tombstoned row at this exact path means the file came back where it
      // was — a drive remounting, or a deletion the user undid. Revive it. This
      // has to be handled before anything else: the bytes may differ from what
      // we last saw, in which case no identity match would fire and the row
      // would stay marked missing forever while `indexFiles` skipped the path
      // as already-indexed.
      if (atSamePath?.missingSince) {
        await deps.mediaRepository.applyMove(config.userId, atSamePath.id, {
          sourcePath: canonical,
          filename: name,
          sizeBytes: st.size,
          mtimeMs: st.mtimeMs ?? null,
        });
        // Unlike a move, the content here may genuinely have changed while we
        // were not watching, so the thumbnail cannot be trusted.
        await deps.regenerateThumbnail(config.userId, atSamePath.id, config.allowedRoots);
        deps.publishJobUpdate?.({
          userId: config.userId, mediaId: atSamePath.id, field: "mediaMoved", value: "1",
        });
        deps.logger.info({ userId: config.userId, path: absPath }, "watch: missing file reappeared");
        return;
      }

      // Before creating anything: is this a file we already know, that simply
      // moved? Creating a new row here is what used to destroy the user's tags,
      // title, starred state, bundles, reminders and extracted text. A live row
      // already sitting on this path rules a move out.
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
      // Refresh the thumbnail to reflect the edited bytes. Text re-extraction on
      // change is intentionally deferred — doing it correctly needs mime-aware,
      // allow-list-carrying OCR enqueue (see enqueueTextExtraction in-place gap).
      await deps.regenerateThumbnail(config.userId, id, config.allowedRoots);
      deps.logger.info({ userId: config.userId, path: absPath }, "watch: refreshed changed file");
    } catch (err) {
      deps.logger.error({ err, path: absPath }, "watch: change handler failed");
    }
  };

  /**
   * Handle the reverse event ordering: on some platforms, and across
   * filesystems, the move's `add` lands before its `unlink`. By the time we get
   * here a bare new row already exists for the destination, holding none of the
   * user's metadata. Transplant the vanished row onto that path and drop the
   * bare one, so the surviving row is the one with the history and the id.
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

/**
 * Live in-place indexing. Watches every user's allowed roots and keeps the Media
 * table in sync with the filesystem: new files get indexed, deleted files/folders
 * get pruned, changed files get their thumbnail + text refreshed.
 *
 * This is best-effort — on bind mounts / network shares inotify may silently
 * no-op even with polling, so a periodic reconciliation scan (see worker/index.ts)
 * is the authoritative backstop. The watcher re-reads configs on an interval so
 * Settings changes (add/remove a root or exclude) take effect without a restart.
 */
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
