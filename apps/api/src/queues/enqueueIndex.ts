/**
 * Describes a request to scan a folder for files, and hands it to the worker
 * that does the scanning.
 */
import type { Queue } from "bullmq";

/**
 * A request to add the files in one folder to the library, leaving them where
 * they are.
 *
 * Everything the scan is allowed to do is fixed when the job is queued, so a
 * preference changed mid-scan does not alter a run already under way. Walking
 * the folder happens in the worker, so a large library does not hold up the
 * request that started it.
 */
export type IndexJobData = {
  userId: string;
  /** Absolute directory to scan. Re-validated against allowedRoots in the worker. */
  rootPath: string;
  /** Recurse into subdirectories. */
  recursive: boolean;
  /** Skip dotfiles (.immich, .DS_Store, …) — mirrors the ignoreHiddenFiles preference. */
  ignoreHidden: boolean;
  /** The folders the user has permitted scanning. The worker checks `rootPath` against these again. */
  allowedRoots: string[];
  /** Filename extensions to pass over, lowercase and without the dot. */
  blacklistExtensions?: string[];
  /** Folders to pass over, along with everything inside them. */
  excludeFolders?: string[];
  /** Pass over build and dependency folders, and files that hold no readable content. */
  skipNonContent?: boolean;
};

/** Live progress attached to the BullMQ job, polled by GET /api/media/index/status. */
export type IndexJobProgress = {
  scanned: number;
  indexed: number;
  skipped: number;
  /** Files the walk declined to offer at all, such as junk folders, empty files and
   *  blacklisted types. A file already in the library counts under `skipped` instead. */
  filtered: number;
  /** True when the walk was stopped early by a dev abort (see lib/media/indexAbort). */
  aborted?: boolean;
};

export const INDEX_QUEUE = process.env.INDEX_QUEUE ?? "index_queue";

export async function enqueueIndex (queue: Queue<IndexJobData>, job: IndexJobData): Promise<string> {
  // One in-flight scan per (user, root): the jobId dedupes repeated submits.
  const jobId = `index-${job.userId}-${Buffer.from(job.rootPath).toString("base64url")}`;

  // BullMQ keeps a finished job's key in Redis for its full retention window,
  // and adding the same id again during that window does nothing at all. Delete
  // a finished job first, or the user cannot start the same scan twice.
  const existing = await queue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state === "completed" || state === "failed") {
      await existing.remove().catch(() => {});
    }
  }

  await queue.add("index", job, {
    jobId,
    attempts: 1, // a partial scan is resumable by re-running; don't auto-retry a long walk
    removeOnComplete: { age: 3600 }, // keep an hour so the UI can read final counts
    removeOnFail: { age: 3600 },
  });
  return jobId;
}
