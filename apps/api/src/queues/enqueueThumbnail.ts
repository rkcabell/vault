//File: apps/api/src/queues/enqueueThumbnail.ts
import type { Queue } from "bullmq";

export type ThumbJob = {
  type: "thumb";
  mediaId: string;
  userId: string;
  storageKey: string;
  outKey: string; // deterministic path for the worker to write the webp
  size: number; // target edge size (px) for the long side
};

export type EnqueueThumbArgs = {
  mediaId: string;
  userId: string;
  storageKey: string;
  size?: number; // default 512
};

export type EnqueueThumbBulkItem = {
  mediaId: string;
  userId: string;
  storageKey: string;
  size?: number;
};

export function computeThumbKey (mediaId: string) {
  return `thumbs/${mediaId}.webp`;
}

/**
 * Factory: returns an enqueue function bound to a BullMQ Queue.
 * Usage:
 *   const enqueueThumb = makeEnqueueThumbnail(q)
 *   const outKey = await enqueueThumb({ mediaId, userId, storageKey, size })
 */
export function makeEnqueueThumbnails (queue: Queue<ThumbJob>) {
  return async function enqueueThumbnail (args: EnqueueThumbArgs): Promise<string> {
    const { mediaId, userId, storageKey, size = 512 } = args;

    const outKey = computeThumbKey(mediaId);
    const job: ThumbJob = {
      type: "thumb",
      mediaId,
      userId,
      storageKey,
      outKey,
      size,
    };

    await queue.add("thumb", job, {
      jobId: mediaId,
      attempts: 5,
      backoff: { type: "exponential", delay: 2000 },
      removeOnFail: true,
      removeOnComplete: true,
    });
    return outKey;
  };
}

export async function enqueueThumbnail (
  queue: Queue<ThumbJob>,
  args: EnqueueThumbArgs,
): Promise<string> {
  return makeEnqueueThumbnails(queue)(args);
}

export async function enqueueThumbBulk (queue: Queue<ThumbJob>, items: EnqueueThumbBulkItem[]) {
  if (!items.length) return;

  const jobs = items.map(item => ({
    name: "thumb",
    data: {
      type: "thumb" as const,
      mediaId: item.mediaId,
      userId: item.userId,
      storageKey: item.storageKey,
      outKey: computeThumbKey(item.mediaId),
      size: item.size ?? 512,
    },
    opts: { jobId: item.mediaId, attempts: 5, backoff: { type: "exponential", delay: 2000 }, removeOnFail: true, removeOnComplete: true },
  }));

  await queue.addBulk(jobs);
}
