import crypto from "crypto";
import type { FastifyBaseLogger } from "fastify";
import type { Queue } from "bullmq";
import type { OcrJobData } from "../ocrProcessingService.js";
import type { S3Adapter } from "../../adapters/s3Adapter.js";
import { deriveTitle } from "../../lib/media/deriveTitle.js";
import { makeStorageKey } from "../../lib/media/keys.js";
import { buildMimeTypeTag } from "../../lib/tags/mimeTypeTag.js";
import type { MediaRepository } from "../../repositories/mediaRepository.js";
import {
  enqueueThumbBulk,
  type ThumbJob,
} from "../../queues/enqueueThumbnail.js";
import { enqueueOcrBulk } from "../../queues/enqueueOcr.js";

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

export function createMediaUploadService (deps: MediaUploadDeps) {
  const initUpload = async (userId: string, body: InitUploadInput) => {
    const id = crypto.randomUUID();
    const storageKey = makeStorageKey(userId, id, body.filename);
    const mimeTag = buildMimeTypeTag(body.mimeType);
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
      mimeType: body.mimeType,
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

  const initBatchUploads = async (userId: string, items: BatchUploadItem[]) => {
    const mediaItems = items.map(item => {
      const id = crypto.randomUUID();
      const storageKey = makeStorageKey(userId, id, item.filename);
      const mimeTag = buildMimeTypeTag(item.mimeType);
      const itemTags = Array.from(
        new Set([...(item.tags ?? []), mimeTag]),
      );
      return {
        id,
        userId,
        storageKey,
        filename: item.filename,
        mimeType: item.mimeType,
        sizeBytes: item.sizeBytes,
        title: deriveTitle(item.filename, item.title),
        tags: itemTags,
        thumbState: "PENDING" as const,
        textState: "PENDING" as const,
        sourceState: "PENDING" as const,
      };
    });

    await deps.repository.createBatch(mediaItems);

    const signedItems = await Promise.all(
      mediaItems.map(async item => {
        const putUrl = await deps.s3Adapter.presignPut({
          bucket: deps.bucket,
          key: item.storageKey,
          contentType: item.mimeType,
          expiresSeconds: MAX_PRESIGNED_SECONDS,
        });
        return { id: item.id, storageKey: item.storageKey, putUrl };
      }),
    );

    return { items: signedItems };
  };

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
