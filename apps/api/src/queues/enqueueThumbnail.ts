// queues/enqueueThumbnail.ts
export const THUMB_QUEUE = "thumb:queue" as const;

export type QueueClient = {
  push: (queue: string, payload: Record<string, unknown>) => Promise<void>;
};

export type ThumbJob = {
  type: "thumb";
  mediaId: string;
  userId: string;
  storageKey: string;
  outKey: string; // deterministic path for the worker to write the webp
  size: number; // target edge size (px) for the long side
  attempt: number; // worker retries can increment this
};

export type EnqueueThumbArgs = {
  mediaId: string;
  userId: string;
  storageKey: string;
  size?: number; // default 512
};

export function computeThumbKey (mediaId: string) {
  return `thumbs/${mediaId}.webp`;
}

/**
 * Factory: returns an enqueue function bound to a QueueClient.
 * Usage:
 *   const enqueueThumb = makeEnqueueThumbnail(q)
 *   const outKey = await enqueueThumb({ mediaId, userId, storageKey, size })
 */
export function makeEnqueueThumbnails (queue: QueueClient) {
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
      attempt: 0,
    };

    // QueueClient handles JSON.stringify internally
    await queue.push(THUMB_QUEUE, job as unknown as Record<string, unknown>);
    return outKey;
  };
}

export async function enqueueThumbnail (
  queue: QueueClient,
  args: EnqueueThumbArgs,
): Promise<string> {
  return makeEnqueueThumbnails(queue)(args);
}
