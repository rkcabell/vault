import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import type { Job, Processor } from "bullmq";
import type { IndexJobData, IndexJobProgress } from "../queues/enqueueIndex.js";
import { assertUnderAllowedRoot, isExcludedFolder } from "../lib/media/indexRoots.js";
import { normalizeExtensions } from "../lib/media/extensions.js";
import { isBuildDir, isNonContentFile, isJunkDir, isJunkFile } from "../lib/media/contentFilters.js";
import {
  type DiscoveredFile,
  type IndexCoreDeps,
  indexFiles,
  isBlacklisted,
} from "./indexCore.js";

type IndexLogger = {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
  error: (obj: object, msg: string) => void;
};

type IndexWorkerDeps = IndexCoreDeps & {
  logger: IndexLogger;
  /**
   * Reads the current abort epoch (see lib/media/indexAbort). The walk captures
   * it once at start and re-checks between batches; if it advances, a dev abort
   * was requested and the walk stops enqueuing. Defaults to "never abort".
   */
  readAbortEpoch?: () => Promise<number>;
  /** Override the batch size (tests use a small value to exercise mid-walk abort). */
  batchSize?: number;
};

/** How many discovered files to insert + enqueue per batch. */
const BATCH_SIZE = 200;

/**
 * Walk a directory yielding regular files. Symlinks are never followed or
 * indexed — that both prevents directory-loop hangs and stops a symlink from
 * pointing the source read outside the allow-listed root. Files whose extension
 * is blacklisted are skipped (the user's "don't index these filetypes" list);
 * directories on the exclude-list (and everything beneath them) are skipped.
 */
async function* walk (
  dir: string,
  recursive: boolean,
  ignoreHidden: boolean,
  blacklist: string[],
  excludeFolders: string[],
  skipNonContent: boolean,
  stats: { filtered: number },
): AsyncGenerator<DiscoveredFile> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // unreadable directory — skip rather than abort the whole scan
  }
  for (const entry of entries) {
    if (ignoreHidden && entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    let st;
    try {
      st = await lstat(full);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      if (isJunkDir(entry.name)) continue;
      if (isExcludedFolder(full, excludeFolders)) continue;
      if (skipNonContent && isBuildDir(entry.name)) continue;
      if (recursive) yield* walk(full, recursive, ignoreHidden, blacklist, excludeFolders, skipNonContent, stats);
    } else if (st.isFile()) {
      // File-level filters — count each pass-over so the scan can report how many
      // files were seen but deliberately not indexed (explains the on-disk gap).
      if (isJunkFile(entry.name)) { stats.filtered++; continue; }
      if (st.size === 0) { stats.filtered++; continue; } // empty placeholders/stubs — no content
      if (isBlacklisted(entry.name, blacklist)) { stats.filtered++; continue; }
      if (skipNonContent && isNonContentFile(entry.name)) { stats.filtered++; continue; }
      yield { absPath: full, name: entry.name, size: st.size };
    }
  }
}

export function createIndexProcessor (deps: IndexWorkerDeps): Processor<IndexJobData> {
  return async (job: Job<IndexJobData>) => {
    const { userId, rootPath, recursive, ignoreHidden, allowedRoots } = job.data;
    const blacklist = normalizeExtensions(job.data.blacklistExtensions);
    const excludeFolders = job.data.excludeFolders ?? [];
    const skipNonContent = job.data.skipNonContent ?? true;

    // allowedRoots is snapshotted at enqueue time — a queued path is never trusted without it.
    const root = assertUnderAllowedRoot(rootPath, allowedRoots);
    deps.logger.info(
      { userId, root, recursive, blacklist: blacklist.length, excluded: excludeFolders.length, skipNonContent },
      "index scan started",
    );

    const batchSize = deps.batchSize ?? BATCH_SIZE;
    const readAbortEpoch = deps.readAbortEpoch ?? (async () => 0);
    // Capture the epoch at start; a later bump means this walk must stop. Reading
    // it between batches (not per file) keeps the Redis hit to one per batch.
    const startEpoch = await readAbortEpoch();
    const isAborted = async () => (await readAbortEpoch()) > startEpoch;

    const progress: IndexJobProgress = { scanned: 0, indexed: 0, skipped: 0, filtered: 0 };
    // walk() mutates this as it passes over junk; progress.filtered mirrors it on each publish.
    const stats = { filtered: 0 };
    let batch: DiscoveredFile[] = [];

    const flush = async () => {
      if (batch.length === 0) return;
      const { indexed, skipped } = await indexFiles(deps, userId, batch, allowedRoots);
      progress.indexed += indexed;
      progress.skipped += skipped;
      progress.filtered = stats.filtered;
      batch = [];
      await job.updateProgress(progress);
    };

    // Tick during the walk: publish scanned count + re-check abort on a ~250ms
    // cadence, independent of batch boundaries. Without it, a sub-batch folder
    // showed "scanned 0" for the whole scan and a deep walk ignored aborts until
    // the next full batch.
    let lastTickAt = 0;
    let aborted = false;
    const tick = async (): Promise<boolean> => {
      const now = Date.now();
      if (now - lastTickAt < 250) return false;
      lastTickAt = now;
      progress.filtered = stats.filtered;
      await job.updateProgress(progress);
      return isAborted();
    };

    for await (const file of walk(root, recursive, ignoreHidden, blacklist, excludeFolders, skipNonContent, stats)) {
      batch.push(file);
      progress.scanned++;
      if (await tick()) { aborted = true; break; }
      if (batch.length >= batchSize) {
        // Check before flushing so an aborted walk doesn't enqueue the batch in hand.
        if (await isAborted()) { aborted = true; break; }
        await flush();
      }
    }
    // Final partial batch — skip it too if an abort landed during the walk.
    if (!aborted && (await isAborted())) aborted = true;
    if (!aborted) await flush();
    progress.filtered = stats.filtered; // reconcile even when the last batch was empty (all-filtered scans)

    if (aborted) {
      progress.aborted = true;
      await job.updateProgress(progress);
      deps.logger.warn({ userId, root, ...progress }, "index scan aborted");
      return progress;
    }

    deps.logger.info({ userId, root, ...progress }, "index scan completed");
    return progress;
  };
}
