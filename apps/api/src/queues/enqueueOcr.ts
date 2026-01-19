import type { JobsOptions, Queue } from "bullmq";
import type { OcrJobData } from "../services/ocrProcessingService.js";

type OcrBulkItem = {
  mediaId: string;
  userId: string;
  storageKey: string;
};

const UPLOAD_OCR_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 2000 },
  delay: 2000,
};

export async function enqueueOcrBulk (queue: Queue<OcrJobData>, items: OcrBulkItem[]) {
  if (!items.length) return;

  await queue.addBulk(
    items.map(item => ({
      name: "ocr",
      data: {
        mediaId: item.mediaId,
        userId: item.userId,
        storageKey: item.storageKey,
      },
      opts: UPLOAD_OCR_JOB_OPTIONS,
    })),
  );
}

export { UPLOAD_OCR_JOB_OPTIONS };
