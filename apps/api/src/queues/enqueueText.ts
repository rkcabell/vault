import type { JobsOptions, Queue } from "bullmq";
import type { OcrJobData } from "../services/ocrProcessingService.js";

/**
 * The tier-1 text queue: native pdf.js reads and direct reads of plain-text
 * files, milliseconds per job. It is kept apart from `ocr_queue` because one
 * 40-minute Tesseract run would hold a shared slot for its whole run, and BullMQ
 * priority orders the wait list rather than evicting a job already running.
 *
 * Both queues carry the same job type and are drained by the same processor;
 * `forceOcr` is what separates them. A job without it never runs Tesseract, and
 * hands off to `ocr_queue` instead. That is what makes this queue safe to run at
 * high concurrency.
 */
export const TEXT_QUEUE = process.env.TEXT_QUEUE ?? "text_queue";

/**
 * Both queues key an item's job on this id, in separate BullMQ key spaces, so a
 * tier-1 job and the tier-2 job it starts can coexist. Every re-enqueue site has
 * to clear the stale job from both: BullMQ drops an add for an id that exists.
 */
export function textJobId (mediaId: string): string {
  return `ocr-${mediaId}`;
}

export type TextBulkItem = {
  mediaId: string;
  userId: string;
  storageKey: string | null;
  allowedRoots?: string[];
};

/**
 * `removeOnComplete` and `removeOnFail` are `true` rather than a retained
 * window: jobs key on {@link textJobId}, and a retained finished job under that
 * id would swallow the next add for the same item.
 */
const TEXT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 2000 },
  delay: 2000,
  removeOnFail: true,
  removeOnComplete: true,
};

/** Adds tier-1 extraction jobs for a batch of items. */
export async function enqueueTextBulk (
  queue: Queue<OcrJobData>,
  items: TextBulkItem[],
  opts: { lifo?: boolean } = {},
) {
  if (!items.length) return;

  await queue.addBulk(
    items.map(item => ({
      name: "text",
      data: {
        mediaId: item.mediaId,
        userId: item.userId,
        storageKey: item.storageKey,
        ...(item.allowedRoots?.length ? { allowedRoots: item.allowedRoots } : {}),
      },
      opts: {
        ...TEXT_JOB_OPTIONS,
        jobId: textJobId(item.mediaId),
        ...(opts.lifo ? { lifo: true } : {}),
      },
    })),
  );
}

export { TEXT_JOB_OPTIONS };
