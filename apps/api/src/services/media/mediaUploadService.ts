import crypto from "crypto";
import type { FastifyBaseLogger } from "fastify";
import type { Queue } from "bullmq";
import type { OcrJobData } from "../ocrProcessingService.js";
import type { StorageAdapter } from "../../adapters/storage/types.js";
import { deriveTitle } from "../../lib/media/deriveTitle.js";
import { makeStorageKey } from "../../lib/media/keys.js";
import { normalizeMimeType } from "../../lib/tags/mimeTypeTag.js";
import { evaluateRules, type TagRuleInput } from "../../lib/tags/rules/evaluateRules.js";
import type { MediaRepository } from "../../repositories/mediaRepository.js";
import {
  enqueueThumbBulk,
  type ThumbJob,
} from "../../queues/enqueueThumbnail.js";
import { enqueueOcrBulk } from "../../queues/enqueueOcr.js";
import { enqueueHashBulk, type HashJobData } from "../../queues/enqueueHash.js";
import { ocrSupported, thumbnailSupported, exceedsThumbnailSize } from "../../lib/media/processingSupport.js";

/** Presigned PUT URL lifetime (10 minutes). Should comfortably cover client upload of large files. */
const MAX_PRESIGNED_SECONDS = 600;

export type InitUploadInput = {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  title: string;
  tags: string[];
  autoTagOnUpload?: boolean;
};

export type BatchUploadItem = {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  title?: string | null;
  tags: string[];
  autoTagOnUpload?: boolean;
};

type MediaUploadDeps = {
  repository: MediaRepository;
  storage: StorageAdapter;
  bucket: string;
  thumbQueue: Queue<ThumbJob>;
  ocrQueue: Queue<OcrJobData>;
  /** Stream-hash queue for items the thumb worker won't hash (non-thumbnailable
   *  or too-large) — keeps contentHash coverage complete for dedup. Optional so
   *  existing tests/fakes keep working. */
  hashQueue?: Queue<HashJobData>;
  logger: FastifyBaseLogger;
  /** The user's enabled Tag Organizer rules (see lib/tags/rules/evaluateRules). */
  listTagRules: (userId: string) => Promise<TagRuleInput[]>;
  /** Publishes a media event so other open library views (tabs) pick up the new items. */
  publishJobUpdate?: (update: { userId: string; mediaId: string; field: string; value: string }) => void;
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
   * The user's Tag Organizer rules (type:, size buckets, …) are evaluated and
   * merged into the caller-supplied tags; duplicates are removed before
   * persisting.
   */
  const initUpload = async (userId: string, body: InitUploadInput) => {
    const id = crypto.randomUUID();
    const storageKey = makeStorageKey(userId, id, body.filename);
    const mimeType = normalizeMimeType(body.mimeType, body.filename);
    const userTags = body.tags ?? [];
    const includeAuto = body.autoTagOnUpload !== false;
    const ruleTags = includeAuto
      ? evaluateRules(await deps.listTagRules(userId), {
          filename: body.filename,
          mimeType,
          sizeBytes: body.sizeBytes,
          ingest: "upload",
        })
      : [];
    // A rule tag is auto unless the user also typed it (then user intent wins).
    const autoTags = ruleTags.filter(tag => !userTags.includes(tag));
    const uniqueTags = Array.from(new Set([...userTags, ...ruleTags]));

    const media = await deps.repository.createMedia(
      {
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
      },
      { autoTags },
    );

    const uploadUrl = await deps.storage.presignPut({
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
    // One rules fetch covers the whole batch.
    const rules = items.some(item => item.autoTagOnUpload !== false)
      ? await deps.listTagRules(userId)
      : [];
    const autoTagsByItem: string[][] = [];
    const mediaItems = items.map(item => {
      const id = crypto.randomUUID();
      const storageKey = makeStorageKey(userId, id, item.filename);
      const mimeType = normalizeMimeType(item.mimeType, item.filename);
      const userTags = item.tags ?? [];
      const includeAuto = item.autoTagOnUpload !== false;
      const ruleTags = includeAuto
        ? evaluateRules(rules, {
            filename: item.filename,
            mimeType,
            sizeBytes: item.sizeBytes,
            ingest: "upload",
          })
        : [];
      const itemTags = Array.from(new Set([...userTags, ...ruleTags]));
      // A rule tag is auto unless the user also typed it (then user intent wins).
      autoTagsByItem.push(ruleTags.filter(tag => !userTags.includes(tag)));
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

    await deps.repository.createBatch(mediaItems, { autoTagsByItem });

    // Presign in chunks of 20 to avoid saturating the S3 client connection pool
    // when batch-uploading large numbers of files.
    const PRESIGN_CHUNK = 20;
    const signedItems: { id: string; storageKey: string; putUrl: string }[] = [];
    for (let i = 0; i < mediaItems.length; i += PRESIGN_CHUNK) {
      const chunk = mediaItems.slice(i, i + PRESIGN_CHUNK);
      const chunkSigned = await Promise.all(
        chunk.map(async item => {
          const putUrl = await deps.storage.presignPut({
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

    const ocrItems = mediaItems.filter(item => ocrSupported(item.mimeType));
    const ocrUnsupported = mediaItems.filter(item => !ocrSupported(item.mimeType));
    // Thumbnails: a file must be a supported type AND small enough to load into
    // memory. Too-large files are marked UNSUPPORTED here instead of enqueueing a job
    // the worker can only fail (it can't buffer a >2 GiB source).
    const thumbUnsupported = mediaItems.filter(item => !thumbnailSupported(item.mimeType));
    const thumbnailable = mediaItems.filter(item => thumbnailSupported(item.mimeType));
    const thumbTooLarge = thumbnailable.filter(item => exceedsThumbnailSize(item.sizeBytes));
    const thumbItems = thumbnailable.filter(item => !exceedsThumbnailSize(item.sizeBytes));
    // Items that skip the thumb job get a hash job instead, so contentHash
    // coverage stays complete for dedup (the thumb worker hashes everything it
    // processes as a side effect).
    const hashItems = [...thumbUnsupported, ...thumbTooLarge];

    await Promise.all([
      thumbItems.length > 0
        ? enqueueThumbBulk(
            deps.thumbQueue,
            thumbItems.map(item => ({
              mediaId: item.id,
              userId,
              storageKey: item.storageKey,
              size: 512,
            })),
          )
        : Promise.resolve(),
      ocrItems.length > 0
        ? enqueueOcrBulk(
            deps.ocrQueue,
            ocrItems.map(item => ({
              mediaId: item.id,
              userId,
              storageKey: item.storageKey,
            })),
          )
        : Promise.resolve(),
      ocrUnsupported.length > 0
        ? deps.repository.markTextUnsupported(ocrUnsupported.map(item => item.id))
        : Promise.resolve(),
      thumbUnsupported.length > 0
        ? deps.repository.markThumbUnsupported(thumbUnsupported.map(item => item.id))
        : Promise.resolve(),
      thumbTooLarge.length > 0
        ? deps.repository.markThumbTooLarge(thumbTooLarge.map(item => item.id))
        : Promise.resolve(),
      hashItems.length > 0 && deps.hashQueue
        ? enqueueHashBulk(
            deps.hashQueue,
            hashItems.map(item => ({
              mediaId: item.id,
              userId,
              storageKey: item.storageKey,
            })),
          )
        : Promise.resolve(),
    ]);

    // New items are live — other open library views learn of them from this
    // event (the uploading tab navigates to /library and refetches itself).
    deps.publishJobUpdate?.({ userId, mediaId: "*", field: "mediaCreated", value: String(mediaItems.length) });

    return { ok: true, count: mediaItems.length };
  };

  return {
    initUpload,
    initBatchUploads,
    finalizeBatch,
  };
}
