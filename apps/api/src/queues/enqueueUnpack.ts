import type { Queue } from "bullmq";

/**
 * Job that unpacks one archive into a bundle of items.
 */

export type UnpackJob = {
  mediaId: string;
  userId: string;
  mimeType: string;
  /** Allow-list snapshot for an archive on the user's own drive. The worker
   *  re-validates `sourcePath` against it, and reads nothing without it. */
  allowedRoots?: string[];
};

export const UNPACK_QUEUE = process.env.UNPACK_QUEUE ?? "unpack_queue";

export async function enqueueUnpack (queue: Queue<UnpackJob>, job: UnpackJob): Promise<void> {
  await queue.add("unpack", job, {
    jobId: `unpack-${job.mediaId}`,
    attempts: 2,
    backoff: { type: "exponential", delay: 5000 },
    removeOnFail: true,
    removeOnComplete: true,
  });
}
