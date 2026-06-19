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
};

/** Live progress attached to the BullMQ job, polled by GET /api/media/index/status. */
export type IndexJobProgress = {
  scanned: number;
  indexed: number;
  skipped: number;
};

export const INDEX_QUEUE = process.env.INDEX_QUEUE ?? "index_queue";

export async function enqueueIndex (queue: Queue<IndexJobData>, job: IndexJobData): Promise<string> {
  // One in-flight scan per (user, root): the jobId dedupes repeated submits.
  const jobId = `index-${job.userId}-${Buffer.from(job.rootPath).toString("base64url")}`;
  await queue.add("index", job, {
    jobId,
    attempts: 1, // a partial scan is resumable by re-running; don't auto-retry a long walk
    removeOnComplete: { age: 3600 }, // keep an hour so the UI can read final counts
    removeOnFail: { age: 3600 },
  });
  return jobId;
}
