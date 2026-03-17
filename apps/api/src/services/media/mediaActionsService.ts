import type { Queue } from "bullmq";
import type { OcrJobData } from "../ocrProcessingService.js";
import type { MediaRepository } from "../../repositories/mediaRepository.js";
import type { S3Adapter } from "../../adapters/s3Adapter.js";
import type { ThumbJob } from "../../queues/enqueueThumbnail.js";
import { computeThumbKey } from "../../queues/enqueueThumbnail.js";

const MAX_PRESIGNED_SECONDS = 600;

export type TextExtractionOptions = {
  language?: string;
  rotation?: "0" | "90" | "180" | "270";
  forceOcr?: boolean;
};

type MediaActionsDeps = {
  repository: MediaRepository;
  s3Adapter: S3Adapter;
  bucket: string;
  ocrQueue: Queue<OcrJobData>;
  thumbQueue: Queue<ThumbJob>;
};

export function createMediaActionsService (deps: MediaActionsDeps) {
  const deleteMedia = async (userId: string, id: string) => {
    const media = await deps.repository.findMediaKeys(userId, id);
    if (!media) return null;

    await deps.s3Adapter.deleteIfPresent({ bucket: deps.bucket, key: media.storageKey });
    if (media.thumbnailKey) {
      await deps.s3Adapter.deleteIfPresent({ bucket: deps.bucket, key: media.thumbnailKey });
    }

    await deps.repository.deleteMedia(id);

    return { ok: true };
  };

  const updateMediaMetadata = async (
    userId: string,
    id: string,
    data: { title?: string; tags?: string[] },
  ) => {
    const media = await deps.repository.findMediaForUpdate(userId, id);
    if (!media) return null;

    return deps.repository.updateMetadata(media.id, data);
  };

  const enqueueTextExtraction = async (
    userId: string,
    id: string,
    options: TextExtractionOptions,
  ) => {
    const media = await deps.repository.findForTextJob(userId, id);
    if (!media) return null;

    // BullMQ deduplicates by jobId — a completed or failed job with the same id
    // blocks new adds silently. Remove any stale terminal job before re-queueing.
    const staleJob = await deps.ocrQueue.getJob(`ocr-${media.id}`);
    if (staleJob) {
      try {
        await staleJob.remove();
      } catch {
        // Active jobs cannot be removed; dedup will prevent a duplicate (correct).
      }
    }

    await deps.ocrQueue.add(
      "ocr",
      {
        mediaId: media.id,
        userId,
        storageKey: media.storageKey,
        title: media.title,
        language: options.language,
        rotation: options.rotation,
        forceOcr: options.forceOcr ?? false,
      },
      { attempts: 1, jobId: `ocr-${media.id}` },
    );

    await deps.repository.setTextStatePending(id);

    return { ok: true };
  };

  const cancelTextExtraction = async (userId: string, id: string) => {
    const media = await deps.repository.findForTextJob(userId, id);
    if (!media) return null;

    const job = await deps.ocrQueue.getJob(`ocr-${media.id}`);
    if (job) {
      try {
        await job.remove();
      } catch {
        // Active jobs cannot be removed; cancellation is best-effort.
      }
    }

    await deps.repository.setTextState(media.id, "ERROR");

    return { ok: true };
  };

  const getDownloadUrl = async (userId: string, id: string) => {
    const media = await deps.repository.findStorageKey(userId, id);
    if (!media) return null;

    const url = await deps.s3Adapter.presignGet({
      bucket: deps.bucket,
      key: media.storageKey,
      expiresSeconds: MAX_PRESIGNED_SECONDS,
    });

    return { url };
  };

  const regenerateThumbnail = async (userId: string, id: string) => {
    const media = await deps.repository.findMediaKeys(userId, id);
    if (!media) return null;

    await deps.repository.resetThumbState(id);

    await deps.thumbQueue.add(
      "thumb",
      {
        type: "thumb",
        mediaId: id,
        userId,
        storageKey: media.storageKey,
        outKey: computeThumbKey(id),
        size: 512,
      },
      { jobId: `thumb-regen-${id}-${Date.now()}`, attempts: 3, backoff: { type: "exponential", delay: 2000 } },
    );

    return { ok: true };
  };

  return {
    deleteMedia,
    updateMediaMetadata,
    enqueueTextExtraction,
    cancelTextExtraction,
    getDownloadUrl,
    regenerateThumbnail,
  };
}
