import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import sharp from "sharp";
import type { Logger } from "pino";
import type { MediaRepository } from "../../repositories/mediaRepository.js";
import type { MediaMetadataRepository } from "../../repositories/mediaMetadataRepository.js";
import { waitUntilObjectExists } from "../../adapters/s3ObjectProbe.js";
import { streamToBuffer } from "../../lib/streams/toBuffer.js";
import { looksLikeHeic, looksLikeMp4, looksLikePdf, looksLikePng } from "../../lib/fileSignatures.js";
import { renderPdfThumbnail } from "./renderPdfThumbnail.js";
import { renderVideoThumbnail } from "./renderVideoThumbnail.js";
import { renderHeicThumbnail } from "./renderHeicThumbnail.js";
import { computeThumbKey } from "../../queues/enqueueThumbnail.js";
import { extractMetadataFromBuffer } from "../media/metadata/extractMediaMetadata.js";

export type ThumbJob = {
  type: "thumb";
  mediaId: string;
  userId: string;
  storageKey: string;
  outKey?: string;
  size?: number; // defaults to 512
};

export type ThumbDeps = {
  prismaMedia: MediaRepository;
  metadataRepository?: MediaMetadataRepository;
  s3: S3Client;
  bucket: string;
  logger: Logger;
  queueName: string;
  publishJobUpdate?: (update: { userId: string; mediaId: string; field: "thumbState"; value: "READY" | "FAILED" }) => void;
};

const THUMB_ERROR_FALLBACK = "thumbnail_failed";
const MAX_THUMB_ERROR_LENGTH = 160;

export function sanitizeThumbError (err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const cleaned = raw.replace(/\s+/g, " ").trim();
  if (!cleaned) return THUMB_ERROR_FALLBACK;
  return cleaned.length > MAX_THUMB_ERROR_LENGTH
    ? cleaned.slice(0, MAX_THUMB_ERROR_LENGTH)
    : cleaned;
}

async function getObjectToBuffer (s3: S3Client, bucket: string, key: string): Promise<Buffer | null> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = res.Body;
    if (!body) return null;
    return streamToBuffer(body as NodeJS.ReadableStream);
  } catch {
    return null;
  }
}

async function renderWebp(input: Buffer, size: number): Promise<Buffer> {
  return sharp(input, { failOn: "none" })
    .rotate()
    .resize(size, size, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer();
}


export async function processThumb (deps: ThumbDeps, job: ThumbJob): Promise<void> {
  const { prismaMedia, s3, bucket, logger } = deps;
  const startedAt = Date.now();

  const size = Math.max(16, Math.min(4096, job.size ?? 512));
  const outKey = job.outKey ?? computeThumbKey(job.mediaId);
  const storageKey = job.storageKey;
  const logContext = {
    jobName: "thumb" as const,
    queue: deps.queueName,
    mediaId: job.mediaId,
    userId: job.userId ?? null,
  };

  const existing = await prismaMedia.findThumbInfo(job.mediaId);

  if (existing?.thumbnailKey === outKey) {
    if (existing.thumbState !== "READY") {
      await prismaMedia.setThumbReady(job.mediaId, outKey);
      deps.publishJobUpdate?.({ userId: job.userId, mediaId: job.mediaId, field: "thumbState", value: "READY" });
    }
    return;
  }

  const exists = await waitUntilObjectExists(s3, bucket, storageKey, { maxTries: 4 });
  if (!exists) throw new Error("SOURCE_NOT_READY");

  const original = await getObjectToBuffer(s3, bucket, storageKey);
  if (!original) throw new Error("SOURCE_NOT_READY");

  let inputForSharp: Buffer = original;
  const mimeType = existing?.mimeType ?? "";

  // Extract and persist file metadata from the buffer we already have.
  // Non-fatal: a metadata failure must never fail the thumbnail job.
  if (deps.metadataRepository && mimeType) {
    extractMetadataFromBuffer(original, mimeType)
      .then((meta) => {
        if (meta) return deps.metadataRepository!.upsert(job.mediaId, meta);
      })
      .catch((err: unknown) => logger.warn({ err, mediaId: job.mediaId }, "metadata extraction failed"));
  }
  const isHeic =
    mimeType.includes("heic") ||
    mimeType.includes("heif") ||
    looksLikeHeic(original);
  const isVideo = mimeType.startsWith("video/") || (looksLikeMp4(original) && !isHeic);
  const isPdf = mimeType.includes("pdf") || looksLikePdf(original);

  if (isVideo) {
    try {
      inputForSharp = await renderVideoThumbnail({
        video: original,
        targetWidth: Math.min(1600, Math.max(800, size * 3)),
      });

      if (!looksLikePng(inputForSharp)) {
        throw new Error("VIDEO_RENDER_DID_NOT_RETURN_PNG");
      }
    } catch (err) {
      const reason = sanitizeThumbError(err);
      await prismaMedia.setThumbFailed(job.mediaId, reason);
      deps.publishJobUpdate?.({ userId: job.userId, mediaId: job.mediaId, field: "thumbState", value: "FAILED" });
      logger.error(
        { ...logContext, reason, errorCode: reason, durationMs: Date.now() - startedAt, err },
        "failed to render video thumbnail",
      );
      return;
    }
  } else if (isPdf) {
    try {
      inputForSharp = await renderPdfThumbnail({
        pdf: original,
        targetWidth: Math.min(1600, Math.max(800, size * 3)),
      });

      if (!looksLikePng(inputForSharp)) {
        throw new Error("PDF_RENDER_DID_NOT_RETURN_PNG");
      }
    } catch (err) {
      const reason = sanitizeThumbError(err);
      await prismaMedia.setThumbFailed(job.mediaId, reason);
      deps.publishJobUpdate?.({ userId: job.userId, mediaId: job.mediaId, field: "thumbState", value: "FAILED" });
      logger.error(
        { ...logContext, reason, errorCode: reason, durationMs: Date.now() - startedAt, err },
        "failed to render PDF thumbnail",
      );
      return;
    }
  } else if (isHeic) {
    try {
      inputForSharp = await renderHeicThumbnail({
        image: original,
        targetWidth: Math.min(1600, Math.max(800, size * 3)),
      });

      if (!looksLikePng(inputForSharp)) {
        throw new Error("HEIC_RENDER_DID_NOT_RETURN_PNG");
      }
    } catch (err) {
      const reason = sanitizeThumbError(err);
      await prismaMedia.setThumbFailed(job.mediaId, reason);
      deps.publishJobUpdate?.({ userId: job.userId, mediaId: job.mediaId, field: "thumbState", value: "FAILED" });
      logger.error(
        { ...logContext, reason, errorCode: reason, durationMs: Date.now() - startedAt, err },
        "failed to render HEIC thumbnail",
      );
      return;
    }
  }

  let webp: Buffer;

  try {
    webp = await renderWebp(inputForSharp, size);
  } catch (err) {
    const reason = sanitizeThumbError(err);
    await prismaMedia.setThumbFailed(job.mediaId, reason);
    deps.publishJobUpdate?.({ userId: job.userId, mediaId: job.mediaId, field: "thumbState", value: "FAILED" });
    logger.error(
      { ...logContext, reason, errorCode: reason, durationMs: Date.now() - startedAt, err },
      "failed to render thumbnail",
    );
    return;
  }

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: outKey,
      Body: webp,
      ContentType: "image/webp",
      CacheControl: "public, max-age=31536000, immutable",
    }),
  );

  await prismaMedia.setThumbReady(job.mediaId, outKey);
  deps.publishJobUpdate?.({ userId: job.userId, mediaId: job.mediaId, field: "thumbState", value: "READY" });
}

export function createThumbProcessor (deps: ThumbDeps) {
  return async (job: { data: ThumbJob; id?: string; attemptsMade?: number }) => {
    const start = Date.now();
    const context = {
      jobName: "thumb" as const,
      queue: deps.queueName,
      jobId: job.id ?? "unknown",
      mediaId: job.data.mediaId,
      userId: job.data.userId ?? null,
      attempt: job.attemptsMade ?? 0,
    };
    deps.logger.info(context, "thumb job started");
    try {
      await processThumb(deps, job.data);
      deps.logger.info({ ...context, durationMs: Date.now() - start }, "thumb job completed");
    } catch (err) {
      const msg =
        err instanceof Error && err.message ? err.message : typeof err === "string" ? err : "Error";
      deps.logger.error(
        {
          ...context,
          durationMs: Date.now() - start,
          errorCode: msg,
          err,
        },
        "thumb job failed",
      );
      throw err;
    }
  };
}
