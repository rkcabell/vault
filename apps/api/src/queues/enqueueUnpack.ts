import type { Queue } from "bullmq";

export type UnpackJob = {
  mediaId: string;
  userId: string;
  storageKey: string;
  mimeType: string;
};

export const UNPACK_QUEUE = process.env.UNPACK_QUEUE ?? "unpack_queue";

export async function enqueueUnpack (queue: Queue<UnpackJob>, job: UnpackJob): Promise<void> {
  await queue.add("unpack", job, {
    jobId: `unpack-${job.mediaId}`,
    attempts: 2,
    backoff: { type: "exponential", delay: 5000 },
  });
}
