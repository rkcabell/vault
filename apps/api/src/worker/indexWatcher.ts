import path from "node:path";
import { lstat } from "node:fs/promises";
import chokidar, { type FSWatcher } from "chokidar";
import type { IndexConfig } from "../services/preferencesService.js";
import type { MediaRepository } from "../repositories/mediaRepository.js";
import { isUnderAllowedRoot, isExcludedFolder } from "../lib/media/indexRoots.js";
import { normalizeExtensions } from "../lib/media/extensions.js";
import { isBuildDir, isNonContentFile, isJunkDir, isJunkFile } from "../lib/media/contentFilters.js";
import { type IndexCoreDeps, indexFiles, isBlacklisted } from "./indexCore.js";

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
 * The filesystem-event handlers, decoupled from chokidar so they can be unit
 * tested with injected deps + a fake config list. `getConfigs` is read fresh on
 * every event so settings changes (re-synced by the watcher) take effect without
 * re-wiring handlers.
 */
export function createIndexEventHandlers (deps: IndexWatcherDeps, getConfigs: () => IndexConfig[]) {
  const statFile = deps.statFile ?? (async (p: string) => lstat(p));

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
      const file = { absPath, name: path.basename(absPath), size: st.size, mtimeMs: st.mtimeMs };
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
      const id = await deps.mediaRepository.findIdBySourcePath(config.userId, absPath);
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

  const onUnlink = async (absPath: string): Promise<void> => {
    try {
      for (const config of getConfigs()) {
        if (!isUnderAllowedRoot(absPath, config.allowedRoots)) continue;
        const id = await deps.mediaRepository.findIdBySourcePath(config.userId, absPath);
        if (id) {
          await deps.deleteMedia(config.userId, id);
          deps.logger.info({ userId: config.userId, path: absPath }, "watch: removed deleted file");
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
        const ids = await deps.mediaRepository.findIdsBySourcePathPrefix(config.userId, absPath);
        for (const id of ids) await deps.deleteMedia(config.userId, id);
        if (ids.length > 0) {
          deps.logger.info({ userId: config.userId, path: absPath, count: ids.length }, "watch: removed deleted folder");
        }
      }
    } catch (err) {
      deps.logger.error({ err, path: absPath }, "watch: unlinkDir handler failed");
    }
  };

  return { onAdd, onChange, onUnlink, onUnlinkDir };
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
