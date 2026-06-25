import type { JobsOptions, Queue } from "bullmq";
import type { OcrJobData } from "../services/ocrProcessingService.js";

type OcrBulkItem = {
  mediaId: string;
  userId: string;
  storageKey: string;
  allowedRoots?: string[];
};

const UPLOAD_OCR_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 2000 },
  delay: 2000,
  removeOnFail: true,
  removeOnComplete: true,
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
        ...(item.allowedRoots?.length ? { allowedRoots: item.allowedRoots } : {}),
      },
      opts: { ...UPLOAD_OCR_JOB_OPTIONS, jobId: `ocr-${item.mediaId}` },
    })),
  );
}

export { UPLOAD_OCR_JOB_OPTIONS };
