import type { Queue } from "bullmq";
import type { OcrJobData } from "../services/ocrProcessingService.js";

type OcrBulkItem = {
  mediaId: string;
  userId: string;
  storageKey: string;
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
      opts: { attempts: 5, backoff: { type: "exponential", delay: 2000 } },
    })),
  );
}
