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
