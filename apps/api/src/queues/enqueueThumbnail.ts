import type { Queue } from "bullmq";

/**
 * Job that renders one item's thumbnail.
 */

export type ThumbJob = {
  type: "thumb";
  mediaId: string;
  userId: string;
  storageKey: string | null;
  // Undefined on a standard job: processThumb falls back to
  // computeThumbKey(mediaId) and 512. A duplicate's thumbnail was rendered at
  // those defaults, so thumbnailService skips reuse when either one is set.
  outKey?: string;
  size?: number;
  sourcePath?: string; // set for an item indexed in place; read from disk, read-only
  allowedRoots?: string[]; // snapshot of the user's roots, taken when queued
  // Forces a fresh render instead of reusing a duplicate's thumbnail.
  noReuse?: boolean;
};

export type EnqueueThumbBulkItem = {
  mediaId: string;
  userId: string;
  storageKey: string | null;
  size?: number;
  sourcePath?: string;
  allowedRoots?: string[];
};

export function computeThumbKey (mediaId: string) {
  return `thumbs/${mediaId}.webp`;
}

/**
 * Adds a batch of thumbnail jobs. `lifo` puts them at the tail of the wait list,
 * which is the end the worker pops from, so they run before everything already
 * queued. The feeder leaves it off, so its backlog drains in claim order.
 */
export async function enqueueThumbBulk (
  queue: Queue<ThumbJob>,
  items: EnqueueThumbBulkItem[],
  opts: { lifo?: boolean } = {},
) {
  if (!items.length) return;

  const jobs = items.map(item => ({
    name: "thumb",
    data: {
      type: "thumb" as const,
      mediaId: item.mediaId,
      userId: item.userId,
      storageKey: item.storageKey,
      ...(item.size !== undefined ? { size: item.size } : {}),
      ...(item.sourcePath ? { sourcePath: item.sourcePath } : {}),
      ...(item.allowedRoots?.length ? { allowedRoots: item.allowedRoots } : {}),
    },
    opts: {
      jobId: item.mediaId,
      attempts: 5,
      backoff: { type: "exponential" as const, delay: 2000 },
      removeOnFail: true,
      removeOnComplete: true,
      ...(opts.lifo ? { lifo: true } : {}),
    },
  }));

  await queue.addBulk(jobs);
}
