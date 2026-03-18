import crypto from "crypto";
import type { FastifyBaseLogger } from "fastify";
import type { Queue } from "bullmq";
import type { OcrJobData } from "../ocrProcessingService.js";
import type { S3Adapter } from "../../adapters/s3Adapter.js";
import { deriveTitle } from "../../lib/media/deriveTitle.js";
import { makeStorageKey } from "../../lib/media/keys.js";
import { buildMimeTypeTag, normalizeMimeType } from "../../lib/tags/mimeTypeTag.js";
import type { MediaRepository } from "../../repositories/mediaRepository.js";
import {
  enqueueThumbBulk,
  type ThumbJob,
} from "../../queues/enqueueThumbnail.js";
import { enqueueOcrBulk } from "../../queues/enqueueOcr.js";

/** Presigned PUT URL lifetime (10 minutes). Should comfortably cover client upload of large files. */
const MAX_PRESIGNED_SECONDS = 600;

export type InitUploadInput = {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  title: string;
  tags: string[];
};

export type BatchUploadItem = {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  title?: string | null;
  tags: string[];
};

type MediaUploadDeps = {
  repository: MediaRepository;
  s3Adapter: S3Adapter;
  bucket: string;
  thumbQueue: Queue<ThumbJob>;
  ocrQueue: Queue<OcrJobData>;
  logger: FastifyBaseLogger;
};

/**
 * Factory for the media upload service. Handles single and batch upload flows:
 * 1. `initUpload` / `initBatchUploads` — create DB records and return presigned S3 PUT URLs.
 * 2. `finalizeBatch` — called after the client confirms uploads are done; marks
 *    sourceState READY and enqueues thumbnail + OCR jobs.
 */
export function createMediaUploadService (deps: MediaUploadDeps) {
  /**
   * Create a single Media record with all states set to PENDING, then generate
   * a presigned S3 PUT URL for the client to upload the file directly.
   * A MIME-type tag is automatically merged into the caller-supplied tags;
   * duplicates are removed with Set deduplication before persisting.
   */
  const initUpload = async (userId: string, body: InitUploadInput) => {
    const id = crypto.randomUUID();
    const storageKey = makeStorageKey(userId, id, body.filename);
    const mimeType = normalizeMimeType(body.mimeType, body.filename);
    const mimeTag = buildMimeTypeTag(mimeType, body.filename);
    const uniqueTags = Array.from(
      new Set([...(body.tags ?? []), mimeTag]),
    );

    const media = await deps.repository.createMedia({
      id,
      userId,
      thumbState: "PENDING",
      textState: "PENDING",
      sourceState: "PENDING",
      storageKey,
      filename: body.filename,
      mimeType,
      sizeBytes: body.sizeBytes,
      title: body.title,
      tags: uniqueTags,
    });

    const uploadUrl = await deps.s3Adapter.presignPut({
      bucket: deps.bucket,
      key: storageKey,
      contentType: body.mimeType,
      expiresSeconds: MAX_PRESIGNED_SECONDS,
    });

    return { id: media.id, uploadUrl, storageKey: media.storageKey };
  };

  /**
   * Bulk variant of initUpload. Creates all Media rows in a single DB write,
   * then concurrently generates a presigned PUT URL per item.
   * Title is derived from filename when not provided by the caller.
   */
  const initBatchUploads = async (userId: string, items: BatchUploadItem[]) => {
    const mediaItems = items.map(item => {
      const id = crypto.randomUUID();
      const storageKey = makeStorageKey(userId, id, item.filename);
      const mimeType = normalizeMimeType(item.mimeType, item.filename);
      const mimeTag = buildMimeTypeTag(mimeType, item.filename);
      const itemTags = Array.from(
        new Set([...(item.tags ?? []), mimeTag]),
      );
      return {
        id,
        userId,
        storageKey,
        filename: item.filename,
        mimeType,
        sizeBytes: item.sizeBytes,
        title: deriveTitle(item.filename, item.title),
        tags: itemTags,
        thumbState: "PENDING" as const,
        textState: "PENDING" as const,
        sourceState: "PENDING" as const,
      };
    });

    await deps.repository.createBatch(mediaItems);

    // Presign in chunks of 20 to avoid saturating the S3 client connection pool
    // when batch-uploading large numbers of files.
    const PRESIGN_CHUNK = 20;
    const signedItems: { id: string; storageKey: string; putUrl: string }[] = [];
    for (let i = 0; i < mediaItems.length; i += PRESIGN_CHUNK) {
      const chunk = mediaItems.slice(i, i + PRESIGN_CHUNK);
      const chunkSigned = await Promise.all(
        chunk.map(async item => {
          const putUrl = await deps.s3Adapter.presignPut({
            bucket: deps.bucket,
            key: item.storageKey,
            contentType: item.mimeType,
            expiresSeconds: MAX_PRESIGNED_SECONDS,
          });
          return { id: item.id, storageKey: item.storageKey, putUrl };
        }),
      );
      signedItems.push(...chunkSigned);
    }

    return { items: signedItems };
  };

  /**
   * Signal that the client has finished uploading a set of media items.
   * Uses raw SQL (markSourcesReady) to atomically flip sourceState to READY
   * and return storageKeys; then enqueues thumbnail and OCR jobs in parallel.
   * Duplicate ids are de-duped before the DB write. No-ops gracefully if
   * none of the provided ids belong to the user or already transitioned.
   */
  const finalizeBatch = async (userId: string, ids: string[]) => {
    const uniqueIds = Array.from(new Set(ids));
    if (uniqueIds.length === 0) {
      return { ok: true, count: 0 };
    }

    const mediaItems = await deps.repository.markSourcesReady(userId, uniqueIds);

    if (mediaItems.length === 0) {
      return { ok: true, count: 0 };
    }

    await Promise.all([
      enqueueThumbBulk(
        deps.thumbQueue,
        mediaItems.map(item => ({
          mediaId: item.id,
          userId,
          storageKey: item.storageKey,
          size: 512,
        })),
      ),
      enqueueOcrBulk(
        deps.ocrQueue,
        mediaItems.map(item => ({
          mediaId: item.id,
          userId,
          storageKey: item.storageKey,
        })),
      ),
    ]);

    return { ok: true, count: mediaItems.length };
  };

  return {
    initUpload,
    initBatchUploads,
    finalizeBatch,
  };
}
