import crypto from "node:crypto";
import path from "node:path";
import type { Writable } from "node:stream";
import archiver from "archiver";
import type { Queue } from "bullmq";
import type { OcrJobData } from "../ocrProcessingService.js";
import type { MediaRepository } from "../../repositories/mediaRepository.js";
import type { BundleRepository } from "../../repositories/bundleRepository.js";
import type { S3Adapter } from "../../adapters/s3Adapter.js";
import type { ThumbJob } from "../../queues/enqueueThumbnail.js";
import { computeThumbKey, enqueueThumbBulk } from "../../queues/enqueueThumbnail.js";
import { enqueueOcrBulk } from "../../queues/enqueueOcr.js";
import { makeStorageKey } from "../../lib/media/keys.js";
import { extractArchive, isCoverCandidate } from "../archive/extractArchive.js";
import { normalizeTag } from "../../lib/tags/normalizeTags.js";

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

/**
 * Coerce an arbitrary string into a valid tag by stripping invalid characters
 * before passing through the canonical normalizeTag path. Returns null if the
 * result cannot produce a valid tag (e.g. empty after stripping).
 */
function coerceTag(name: string): string | null {
  const prepped = name
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  try {
    return normalizeTag(prepped);
  } catch {
    return null;
  }
}

function extTag(filename: string): string | null {
  const ext = path.extname(filename).toLowerCase();
  const candidate = ext.length > 1 ? ext.slice(1) : null;
  if (!candidate) return null;
  try {
    return normalizeTag(candidate);
  } catch {
    return null;
  }
}

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

export const ARCHIVE_MIME_TYPES = new Set([
  "application/zip",
  "application/x-zip-compressed",
  "application/x-tar",
  "application/gzip",
  "application/x-gzip",
  "application/x-7z-compressed",
  "application/x-rar-compressed",
  "application/vnd.rar",
]);

type MediaActionsDeps = {
  repository: MediaRepository;
  bundleRepository: BundleRepository;
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

    // Clear coverMediaId on any bundle that used this media as its cover.
    await deps.bundleRepository.clearCoverMedia(id);

    return { ok: true };
  };

  const updateMediaMetadata = async (
    userId: string,
    id: string,
    data: { title?: string; tags?: string[] },
  ) => {
    const media = await deps.repository.findMediaForUpdate(userId, id);
    if (!media) return null;

    return deps.repository.updateMetadata(media.id, data, userId);
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

  const unpackArchive = async (
    userId: string,
    mediaId: string,
  ): Promise<{ bundleId: string } | null | "already-linked"> => {
    // Load the media item including its mimeType and title
    const media = await deps.repository.findDetail(userId, mediaId);
    if (!media) return null;

    // Already unpacked
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((media as any).linkedBundleId) return "already-linked";

    // Only proceed for recognised archive types (ZIP, TAR, GZ)
    if (!ARCHIVE_MIME_TYPES.has(media.mimeType)) return null;

    // Fetch the archive stream from S3
    const s3Result = await deps.s3Adapter.getObjectStream({ bucket: deps.bucket, key: media.storageKey });
    if (!s3Result) return null;

    // Derive bundle name from the archive title (strip extension)
    const baseName = path.basename(media.title ?? media.filename, path.extname(media.filename));
    const bundleName = baseName || media.title || "Unpacked Archive";

    // Create the bundle
    const bundle = await deps.bundleRepository.createBundle(userId, bundleName);
    const bundleId = bundle.id;

    const createdIds: string[] = [];
    const thumbItems: { mediaId: string; userId: string; storageKey: string }[] = [];
    const ocrItems: { mediaId: string; userId: string; storageKey: string }[] = [];
    let coverCandidateId: string | null = null;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bodyStream = s3Result.body as any;

    for await (const entry of extractArchive(bodyStream, media.mimeType)) {
      const newId = crypto.randomUUID();
      const filename = path.basename(entry.path);
      if (!filename) continue;

      const storageKey = makeStorageKey(userId, newId, filename);

      // Upload extracted file to S3
      await deps.s3Adapter.putObject({
        bucket: deps.bucket,
        key: storageKey,
        body: entry.stream,
        contentType: entry.mimeType,
        contentLength: entry.size,
      });

      // Derive title from filename (strip extension)
      const title = path.basename(filename, path.extname(filename)) || filename;

      // Create Media record
      await deps.repository.createMedia({
        id: newId,
        userId,
        storageKey,
        filename,
        mimeType: entry.mimeType,
        sizeBytes: entry.size ?? 0,
        title,
        tags: [coerceTag(bundleName), extTag(filename)].filter((t): t is string => t !== null),
        sourceState: "READY",
        thumbState: "PENDING",
        textState: "PENDING",
        sourceArchiveId: mediaId,
      });

      createdIds.push(newId);
      thumbItems.push({ mediaId: newId, userId, storageKey });
      ocrItems.push({ mediaId: newId, userId, storageKey });

      if (!coverCandidateId && isCoverCandidate(entry.mimeType)) {
        coverCandidateId = newId;
      }
    }

    if (createdIds.length === 0) {
      // Nothing was extracted — clean up the empty bundle
      await deps.bundleRepository.deleteBundle(bundleId, userId);
      return null;
    }

    // Enqueue thumbnail + OCR jobs
    await enqueueThumbBulk(deps.thumbQueue, thumbItems);
    await enqueueOcrBulk(deps.ocrQueue, ocrItems);

    // Add all items to bundle
    await deps.bundleRepository.addItems(bundleId, userId, createdIds);

    // Set cover
    if (coverCandidateId) {
      await deps.bundleRepository.updateBundle(bundleId, userId, { coverMediaId: coverCandidateId });
    }

    // Link the archive to the bundle (bidirectionally)
    await deps.repository.setLinkedBundle(mediaId, bundleId);
    await deps.bundleRepository.setSourceMedia(bundleId, mediaId);

    return { bundleId };
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
    unpackArchive,
  };
}
