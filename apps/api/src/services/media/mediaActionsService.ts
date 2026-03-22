import type { Writable } from "node:stream";
import archiver from "archiver";
import type { Queue } from "bullmq";
import type { OcrJobData } from "../ocrProcessingService.js";
import type { MediaRepository } from "../../repositories/mediaRepository.js";
import type { S3Adapter } from "../../adapters/s3Adapter.js";
import type { ThumbJob } from "../../queues/enqueueThumbnail.js";
import { computeThumbKey } from "../../queues/enqueueThumbnail.js";

const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/heic": ".heic",
  "image/heif": ".heif",
  "image/tiff": ".tiff",
  "image/bmp": ".bmp",
  "image/svg+xml": ".svg",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/x-msvideo": ".avi",
  "video/webm": ".webm",
  "video/x-matroska": ".mkv",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
  "text/html": ".html",
  "text/csv": ".csv",
  "application/json": ".json",
  "application/zip": ".zip",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.ms-excel": ".xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.ms-powerpoint": ".ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
};

function sanitizeTitle (title: string): string {
  const cleaned = title.replace(/[/\\:*?"<>|]/g, "").trim().slice(0, 100);
  return cleaned || "";
}

function extFromFilename (filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(dot) : "";
}

function buildFilename (
  item: { id: string; title: string; mimeType: string | null; filename: string },
  usedNames: Set<string>,
): string {
  const ext =
    (item.mimeType && MIME_TO_EXT[item.mimeType]) ??
    extFromFilename(item.filename) ??
    "";
  const base = sanitizeTitle(item.title) || item.id;
  let name = `${base}${ext}`;
  if (!usedNames.has(name)) {
    usedNames.add(name);
    return name;
  }
  let counter = 2;
  while (usedNames.has(name)) {
    name = `${base}_${counter}${ext}`;
    counter++;
  }
  usedNames.add(name);
  return name;
}

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

  const getBulkDownloadItems = async (userId: string, ids: string[]) => {
    return deps.repository.findBulkDownloadItems(userId, ids);
  };

  const streamBulkArchive = async (
    items: { id: string; storageKey: string; title: string; mimeType: string | null; filename: string }[],
    dest: Writable,
    logger: { error: (obj: unknown, msg: string) => void },
  ) => {
    const archive = archiver("zip", { zlib: { level: 0 } });

    archive.on("error", (err) => {
      logger.error(err, "bulk-download archive error");
      if (!dest.writableEnded) dest.destroy(err);
    });

    archive.pipe(dest);

    const usedNames = new Set<string>();
    for (const item of items) {
      const result = await deps.s3Adapter.getObjectStream({ bucket: deps.bucket, key: item.storageKey });
      if (!result) continue;
      const filename = buildFilename(item, usedNames);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      archive.append(result.body as any, { name: filename });
    }

    await archive.finalize();
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
    getBulkDownloadItems,
    streamBulkArchive,
  };
}
