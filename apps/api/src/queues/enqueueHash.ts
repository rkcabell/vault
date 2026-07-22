import type { Queue } from "bullmq";

export const HASH_QUEUE = process.env.HASH_QUEUE ?? "hash_queue";

/** Stream-hash one item's source into Media.contentHash (see worker/hashWorker). */
export type HashJobData = {
  type: "hash";
  mediaId: string;
  userId: string;
  storageKey: string;
  /** Set for in-place indexed items; source read read-only from disk. */
  sourcePath?: string;
  /** Snapshotted from user preferences at enqueue time. */
  allowedRoots?: string[];
};

export type EnqueueHashItem = {
  mediaId: string;
  userId: string;
  storageKey: string;
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
    // jobId = mediaId dedupes re-enqueues of the same item within this queue.
    opts: { jobId: item.mediaId, attempts: 3, backoff: { type: "exponential", delay: 2000 }, removeOnFail: true, removeOnComplete: true },
  }));

  await queue.addBulk(jobs);
}
