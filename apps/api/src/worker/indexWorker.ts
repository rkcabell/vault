import type { Job, Processor } from "bullmq";
import type { IndexJobData, IndexJobProgress } from "../queues/enqueueIndex.js";
import { assertUnderAllowedRoot } from "../lib/media/indexRoots.js";
import { normalizeExtensions } from "../lib/media/extensions.js";
import { walkFiles } from "./indexWalk.js";
import {
  type DiscoveredFile,
  type IndexCoreDeps,
  indexFiles,
} from "./indexCore.js";

/**
 * Runs one index scan: walks a root, and creates a row for each file it finds
 * that has none. Progress and an abort check are published as it goes.
 */

type IndexLogger = {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
  error: (obj: object, msg: string) => void;
};

type IndexWorkerDeps = IndexCoreDeps & {
  logger: IndexLogger;
  /**
   * Reads the current abort epoch. The walk captures it at start and re-reads it
   * between batches; a higher value means an abort was requested, and the walk
   * stops. Absent, the walk never aborts.
   */
  readAbortEpoch?: () => Promise<number>;
  batchSize?: number;
};

/** How many discovered files are written to the database at a time. */
const BATCH_SIZE = 200;

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
    // The epoch is captured at start; a later value means this walk must stop.
    // Reading it per batch rather than per file keeps it to one Redis call.
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

    // Publishes the scanned count and re-checks the abort about every 250 ms,
    // independent of batch boundaries. A folder smaller than one batch would
    // otherwise report nothing until it had finished.
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

    const filters = { recursive, ignoreHidden, blacklist, excludeFolders, skipNonContent };
    for await (const file of walkFiles(root, filters, stats)) {
      batch.push(file);
      progress.scanned++;
      if (await tick()) { aborted = true; break; }
      if (batch.length >= batchSize) {
        // Check before flushing so an aborted walk doesn't enqueue the batch in hand.
        if (await isAborted()) { aborted = true; break; }
        await flush();
      }
    }
    // Final partial batch — skip it if an abort was requested during the walk.
    if (!aborted && (await isAborted())) aborted = true;
    if (!aborted) await flush();
    progress.filtered = stats.filtered; // reconcile even when the last batch was empty

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
