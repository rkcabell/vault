import type { Queue } from "bullmq";

/**
 * A request to scan a server-side directory and index the files it contains in
 * place (no copy). The walk + row creation runs in the worker so a large NAS
 * library never blocks the HTTP request.
 */
export type IndexJobData = {
  userId: string;
  /** Absolute directory to scan. Re-validated against allowedRoots in the worker. */
  rootPath: string;
  /** Recurse into subdirectories. */
  recursive: boolean;
  /** Skip dotfiles (.immich, .DS_Store, …) — mirrors the ignoreHiddenFiles preference. */
  ignoreHidden: boolean;
  /** Snapshotted from user preferences at enqueue time; worker validates rootPath against these. */
  allowedRoots: string[];
  /** Extensions (lowercase, no dot) to skip — snapshotted from preferences at enqueue time. */
  blacklistExtensions?: string[];
  /** Absolute folders (and their subtrees) to skip — snapshotted from preferences at enqueue time. */
  excludeFolders?: string[];
  /** Skip build/dependency dirs + non-content file types — snapshotted from preferences at enqueue time. */
  skipNonContent?: boolean;
};

/** Live progress attached to the BullMQ job, polled by GET /api/media/index/status. */
export type IndexJobProgress = {
  scanned: number;
  indexed: number;
  skipped: number;
  /** Files passed over during the walk (junk dir/file, zero-byte, blacklist, non-content).
   *  Distinct from `skipped`, which counts already-indexed paths the walk did yield. */
  filtered: number;
  /** True when the walk was stopped early by a dev abort (see lib/media/indexAbort). */
  aborted?: boolean;
};

export const INDEX_QUEUE = process.env.INDEX_QUEUE ?? "index_queue";

export async function enqueueIndex (queue: Queue<IndexJobData>, job: IndexJobData): Promise<string> {
  // One in-flight scan per (user, root): the jobId dedupes repeated submits.
  const jobId = `index-${job.userId}-${Buffer.from(job.rootPath).toString("base64url")}`;

  // BullMQ keeps the job key in Redis for the full retention window even after
  // completion or failure (removeOnComplete/Fail: { age }). Within that window,
  // queue.add with the same jobId is a no-op — the worker never re-runs. Remove
  // terminal-state jobs explicitly so the user can re-trigger a scan.
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
