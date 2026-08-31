import type { Queue } from "bullmq";

/**
 * Job that hashes one item's contents into `Media.contentHash`.
 */

export const HASH_QUEUE = process.env.HASH_QUEUE ?? "hash_queue";

export type HashJobData = {
  type: "hash";
  mediaId: string;
  userId: string;
  storageKey: string | null;
  /** Set for an item indexed in place. Its file is read from disk, read-only. */
  sourcePath?: string;
  /** Snapshot of the user's allowed roots, taken when the job was queued. */
  allowedRoots?: string[];
};

export type EnqueueHashItem = {
  mediaId: string;
  userId: string;
  storageKey: string | null;
  sourcePath?: string;
  allowedRoots?: string[];
};

export async function enqueueHashBulk (queue: Queue<HashJobData>, items: EnqueueHashItem[]) {
  if (!items.length) return;

  const jobs = items.map(item => ({
    name: "hash",
    data: {
      type: "hash" as const,
      mediaId: item.mediaId,
      userId: item.userId,
      storageKey: item.storageKey,
      ...(item.sourcePath ? { sourcePath: item.sourcePath } : {}),
      ...(item.allowedRoots?.length ? { allowedRoots: item.allowedRoots } : {}),
    },
    // The media id as jobId dedupes a re-enqueue of the same item.
    opts: { jobId: item.mediaId, attempts: 3, backoff: { type: "exponential", delay: 2000 }, removeOnFail: true, removeOnComplete: true },
  }));

  await queue.addBulk(jobs);
}
