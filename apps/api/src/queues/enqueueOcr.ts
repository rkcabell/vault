import type { JobsOptions, Queue } from "bullmq";
import type { OcrJobData } from "../services/ocrProcessingService.js";
import { textJobId } from "./enqueueText.js";

/**
 * The tier-2 text queue: ocrmypdf and Tesseract only. Each job spawns a
 * subprocess that takes about one core and up to a gigabyte of memory for
 * minutes at a time, so this queue runs near the core count and never shares a
 * pool with the millisecond work on `text_queue`. A job arrives here only with
 * `forceOcr: true`, and never at index time.
 */

export const OCR_QUEUE = process.env.OCR_QUEUE ?? "ocr_queue";

/** BullMQ priority is ascending — lower number runs first. The only fact that
 *  matters is BACKGROUND > USER, so direct requests always jump the sweep. */
export const OCR_PRIORITY_BACKGROUND = 20;
export const OCR_PRIORITY_USER = 1;

/** Single-attempt: a Tesseract run that failed will fail again, and each retry
 *  costs minutes of a core. `removeOnComplete` must stay `true` — the id is
 *  {@link textJobId}, and a retained terminal job would silently swallow the
 *  next add for that item. */
const OCR_JOB_OPTIONS: JobsOptions = {
  attempts: 1,
  removeOnFail: true,
  removeOnComplete: true,
};

/**
 * Adds one item to tier 2. The caller supplies the resolved job data; this sets
 * the job id and the retention policy.
 */
export async function enqueueOcrJob (
  queue: Queue<OcrJobData>,
  data: OcrJobData,
  opts: JobsOptions = {},
) {
  return queue.add("ocr", { ...data, forceOcr: true }, {
    ...OCR_JOB_OPTIONS,
    jobId: textJobId(data.mediaId),
    ...opts,
  });
}

/**
 * Adds a whole batch to tier 2, in one round-trip rather than one per item.
 */
export async function enqueueOcrBulk (
  queue: Queue<OcrJobData>,
  items: OcrJobData[],
  opts: JobsOptions = {},
) {
  if (!items.length) return;

  await queue.addBulk(
    items.map(data => ({
      name: "ocr",
      data: { ...data, forceOcr: true },
      opts: { ...OCR_JOB_OPTIONS, jobId: textJobId(data.mediaId), ...opts },
    })),
  );
}

export { OCR_JOB_OPTIONS };
