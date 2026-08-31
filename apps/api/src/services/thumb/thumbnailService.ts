import crypto from "crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Logger } from "pino";
import type { MediaRepository } from "../../repositories/mediaRepository.js";
import type { MediaMetadataRepository } from "../../repositories/mediaMetadataRepository.js";
import type { StorageAdapter } from "../../adapters/storage/types.js";
import { openSourceStream, readSourceBuffer } from "../../adapters/storage/openSource.js";
import { looksLikeHeic, looksLikeMp4, looksLikePdf, looksLikePng } from "../../lib/fileSignatures.js";
import { renderPdfThumbnail } from "./renderPdfThumbnail.js";
import { renderVideoThumbnail } from "./renderVideoThumbnail.js";
import { renderHeicThumbnail } from "./renderHeicThumbnail.js";
import { computeThumbKey, type ThumbJob } from "../../queues/enqueueThumbnail.js";
import { extractMetadataFromBuffer } from "../media/metadata/extractMediaMetadata.js";
import { resolveFileDate } from "../../lib/tags/rules/fileDate.js";
import { tagDuplicatesForHash } from "../media/duplicateTag.js";
import { exceedsThumbnailSize, THUMBNAIL_TOO_LARGE_REASON } from "../../lib/media/processingSupport.js";

/**
 * Renders an item's thumbnail, choosing a decoder by the file's leading bytes
 * rather than its name. It also extracts the file's metadata and hashes it,
 * while the bytes are already in memory.
 */

type PrefsLookup = { getPreferences: (userId: string) => Promise<{ extractMetadata?: boolean; detectDuplicates?: boolean }> };

export type ThumbDeps = {
  prismaMedia: MediaRepository;
  metadataRepository?: MediaMetadataRepository;
  preferencesService?: PrefsLookup;
  storage: StorageAdapter;
  bucket: string;
  /** The user's allowed roots. Needed to read a source on their own drive. */
  allowedRoots?: string[];
  logger: Logger;
  queueName: string;
  publishJobUpdate?: (update: { userId: string; mediaId: string; field: "thumbState"; value: "READY" | "FAILED" | "UNSUPPORTED" }) => void;
};

/** Stored when the error message is empty after sanitization. */
const THUMB_ERROR_FALLBACK = "thumbnail_failed";
/** Maximum characters persisted in thumbError to keep DB values bounded. */
const MAX_THUMB_ERROR_LENGTH = 160;

/**
 * Converts anything thrown into one short line safe to store. Falls back to a
 * fixed message when nothing usable is left.
 */
export function sanitizeThumbError (err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const cleaned = raw.replace(/\s+/g, " ").trim();
  if (!cleaned) return THUMB_ERROR_FALLBACK;
  return cleaned.length > MAX_THUMB_ERROR_LENGTH
    ? cleaned.slice(0, MAX_THUMB_ERROR_LENGTH)
    : cleaned;
}

/**
 * Resizes an image buffer and encodes it as WebP. `rotate()` with no argument
 * applies the rotation recorded in the file's EXIF. The aspect ratio is kept,
 * and an image already smaller than `size` is left at its own size.
 */
async function renderWebp(input: Buffer, size: number): Promise<Buffer> {
  const { default: sharp } = await import("sharp");
  return sharp(input, { failOn: "none" })
    .rotate()
    .resize(size, size, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer();
}


type FormatHandler = {
  /** Short label used in log messages and error codes (e.g. "video", "pdf"). */
  label: string;
  /** True when this handler should take the file. The first match wins. */
  detect: (mimeType: string, buffer: Buffer) => boolean;
  /** Renders a high-resolution PNG from the source, for encoding to WebP. */
  render: (buffer: Buffer, targetWidth: number) => Promise<Buffer>;
};

/**
 * The format-specific renderers, checked in order. HEIC has to come before
 * video: some HEIC files carry MP4 magic bytes and would be taken for video.
 */
const FORMAT_HANDLERS: FormatHandler[] = [
  {
    label: "heic",
    detect: (mime, buf) => mime.includes("heic") || mime.includes("heif") || looksLikeHeic(buf),
    render: (buf, w) => renderHeicThumbnail({ image: buf, targetWidth: w }),
  },
  {
    label: "video",
    detect: (mime, buf) => mime.startsWith("video/") || looksLikeMp4(buf),
    render: (buf, w) => renderVideoThumbnail({ video: buf, targetWidth: w }),
    // With a pre-streamed videoPath, processThumb calls renderVideoThumbnail
    // directly instead.
  },
  {
    label: "pdf",
    detect: (mime, buf) => mime.includes("pdf") || looksLikePdf(buf),
    render: (buf, w) => renderPdfThumbnail({ pdf: buf, targetWidth: w }),
  },
];

/**
 * Renders one item's thumbnail and records the outcome on its row.
 *
 * A render that fails for a format some handler claimed sets thumbState FAILED
 * and returns rather than throwing, because a retry produces the same result.
 * Bytes no handler claimed, which Sharp also rejects, are UNSUPPORTED instead:
 * no render was ever possible.
 */
export async function processThumb (deps: ThumbDeps, job: ThumbJob): Promise<void> {
  const { prismaMedia, storage, bucket, logger } = deps;
  const startedAt = Date.now();

  const size = Math.max(16, Math.min(4096, job.size ?? 512));
  const outKey = job.outKey ?? computeThumbKey(job.mediaId);
  const storageKey = job.storageKey;
  const allowedRoots = job.allowedRoots?.length ? job.allowedRoots : (deps.allowedRoots ?? []);
  const logContext = {
    jobName: "thumb" as const,
    queue: deps.queueName,
    mediaId: job.mediaId,
    userId: job.userId ?? null,
  };

  const existing = await prismaMedia.findThumbInfo(job.mediaId);

  // In-place indexed items read their original from disk (read-only); managed
  // items read from storage at storageKey. The job carries sourcePath for the
  // bulk index path; the DB row is the fallback (e.g. thumbnail regeneration).
  const sourcePath = job.sourcePath ?? existing?.sourcePath ?? undefined;

  if (existing?.thumbnailKey === outKey) {
    if (existing.thumbState !== "READY") {
      await prismaMedia.setThumbReady(job.mediaId, outKey);
      deps.publishJobUpdate?.({ userId: job.userId, mediaId: job.mediaId, field: "thumbState", value: "READY" });
    }
    return;
  }

  // The whole source is read into a Buffer, and Node cannot hold more than
  // about 2 GiB in one, so a larger file would only occupy a queue slot and
  // fail. It is marked FAILED with a reason, so the UI shows a placeholder
  // rather than a row stuck at PENDING. The size will not change, so this
  // returns rather than throwing.
  if (exceedsThumbnailSize(existing?.sizeBytes)) {
    await prismaMedia.setThumbFailed(job.mediaId, THUMBNAIL_TOO_LARGE_REASON);
    deps.publishJobUpdate?.({ userId: job.userId, mediaId: job.mediaId, field: "thumbState", value: "FAILED" });
    logger.info(
      { ...logContext, sizeBytes: existing?.sizeBytes, reason: THUMBNAIL_TOO_LARGE_REASON, durationMs: Date.now() - startedAt },
      "thumbnail skipped: file too large",
    );
    return;
  }

  const mimeType = existing?.mimeType ?? "";
  const isVideo = mimeType.startsWith("video/");

  // Video streams straight to a temp file: ffmpeg needs it on disk anyway, and
  // buffering it first would hold the whole source in memory at the same time.
  // Other formats read to a buffer.
  let original: Buffer;
  let videoTempDir: string | null = null;
  let videoTempPath: string | null = null;

  try {

  if (isVideo) {
    videoTempDir = await mkdtemp(join(tmpdir(), "vault-src-"));
    videoTempPath = join(videoTempDir, "source.mp4");
    const res = await openSourceStream({ storage, bucket, storageKey, sourcePath, allowedRoots });
    if (!res) throw new Error("SOURCE_NOT_READY");
    await pipeline(res.body, createWriteStream(videoTempPath));
    original = await readFile(videoTempPath);
  } else {
    const buf = await readSourceBuffer({ storage, bucket, storageKey, sourcePath, allowedRoots });
    if (!buf) throw new Error("SOURCE_NOT_READY");
    original = buf;
  }

  let inputForSharp: Buffer = original;

  // Read once, for the extractMetadata and detectDuplicates settings below.
  const prefs = deps.preferencesService && job.userId
    ? await deps.preferencesService.getPreferences(job.userId).catch(() => null)
    : null;

  // Read from the buffer already in hand. A failure here never fails the
  // thumbnail job. Skipped when the user has turned extractMetadata off, which
  // is what keeps EXIF and GPS out of the database.
  if (deps.metadataRepository && mimeType && prefs?.extractMetadata !== false) {
    extractMetadataFromBuffer(original, mimeType)
      .then(async (meta) => {
        if (!meta) return;
        await deps.metadataRepository!.upsert(job.mediaId, meta);
        // A date read from inside the file is better than the modified time
        // stored at index time, so it replaces it.
        const fileDate = resolveFileDate(meta);
        if (fileDate) await prismaMedia.setFileDate(job.mediaId, fileDate);
      })
      .catch((err: unknown) => logger.warn({ err, mediaId: job.mediaId }, "metadata extraction failed"));
  }

  // Hashes the bytes already in hand, and tags duplicates when the user has
  // detectDuplicates on. A failure here never fails the thumbnail job.
  let contentHash: string | null = null;
  try {
    contentHash = crypto.createHash("sha256").update(original).digest("hex");
    await prismaMedia.setContentHash(job.mediaId, contentHash);
    if (prefs?.detectDuplicates && job.userId) {
      await tagDuplicatesForHash(prismaMedia, job.userId, job.mediaId, contentHash);
    }
  } catch (err: unknown) {
    logger.warn({ err, mediaId: job.mediaId }, "hash/duplicate check failed");
  }

  // Copies an existing thumbnail for a byte-identical file rather than
  // rendering again: the copy is a small WebP, where the render would be a PDF
  // rasterization, an ffmpeg frame grab, or a HEIC decode.
  //
  // Only an ordinary job qualifies. An unset outKey and size mark one; a caller
  // asking for anything else wants its own render, and noReuse is set by
  // "regenerate". A miss, a missing blob, or a failed lookup all fall through
  // to a normal render, so reuse never fails a job.
  if (contentHash && job.userId && job.outKey === undefined && job.size === undefined && !job.noReuse) {
    try {
      const twin = await prismaMedia.findReusableThumbnail(job.userId, contentHash, job.mediaId);
      if (twin) {
        const twinObject = await storage.getObjectStream({ bucket, key: twin.thumbnailKey });
        if (twinObject) {
          await storage.putObject({
            bucket,
            key: outKey,
            body: twinObject.body,
            contentType: "image/webp",
            cacheControl: "public, max-age=31536000, immutable",
          });
          await prismaMedia.setThumbReady(job.mediaId, outKey);
          deps.publishJobUpdate?.({ userId: job.userId, mediaId: job.mediaId, field: "thumbState", value: "READY" });
          logger.info(
            { ...logContext, twinMediaId: twin.id, durationMs: Date.now() - startedAt },
            "thumbnail reused from identical file",
          );
          return;
        }
      }
    } catch (err: unknown) {
      logger.warn({ err, mediaId: job.mediaId }, "thumbnail reuse check failed; rendering instead");
    }
  }

  const targetWidth = Math.min(1600, Math.max(800, size * 3));

  // Render a high-res intermediate PNG for formats that Sharp can't decode
  // natively. Returns null and marks the job FAILED on any render error.
  const tryRenderIntermediate = async (
    renderFn: () => Promise<Buffer>,
    label: string,
  ): Promise<Buffer | null> => {
    try {
      const result = await renderFn();
      if (!looksLikePng(result)) throw new Error(`${label.toUpperCase()}_RENDER_DID_NOT_RETURN_PNG`);
      return result;
    } catch (err) {
      const reason = sanitizeThumbError(err);
      await prismaMedia.setThumbFailed(job.mediaId, reason);
      deps.publishJobUpdate?.({ userId: job.userId, mediaId: job.mediaId, field: "thumbState", value: "FAILED" });
      logger.error(
        { ...logContext, reason, errorCode: reason, durationMs: Date.now() - startedAt, err },
        `failed to render ${label} thumbnail`,
      );
      return null;
    }
  };

  const handler = FORMAT_HANDLERS.find(h => h.detect(mimeType, original));
  if (handler) {
    // For video with a pre-streamed temp file, call renderVideoThumbnail directly
    // to skip the redundant buffer→disk write inside the renderer.
    const renderFn = handler.label === "video" && videoTempPath
      ? () => renderVideoThumbnail({ videoPath: videoTempPath!, targetWidth })
      : () => handler.render(original, targetWidth);
    const rendered = await tryRenderIntermediate(renderFn, handler.label);
    if (!rendered) return;
    inputForSharp = rendered;
  }

  let webp: Buffer;

  try {
    webp = await renderWebp(inputForSharp, size);
  } catch (err) {
    // No handler claimed these bytes and Sharp can't decode them either, so no
    // render was ever possible — UNSUPPORTED, which the library's "Thumbnail
    // error" filter correctly ignores. A handler ran means one was attempted.
    if (!handler) {
      await prismaMedia.markThumbUnsupported([job.mediaId]);
      deps.publishJobUpdate?.({ userId: job.userId, mediaId: job.mediaId, field: "thumbState", value: "UNSUPPORTED" });
      logger.info(
        { ...logContext, mimeType, durationMs: Date.now() - startedAt },
        "thumbnail unsupported: no renderer and not a decodable image",
      );
      return;
    }
    const reason = sanitizeThumbError(err);
    await prismaMedia.setThumbFailed(job.mediaId, reason);
    deps.publishJobUpdate?.({ userId: job.userId, mediaId: job.mediaId, field: "thumbState", value: "FAILED" });
    logger.error(
      { ...logContext, reason, errorCode: reason, durationMs: Date.now() - startedAt, err },
      "failed to render thumbnail",
    );
    return;
  }

  await storage.putObject({
    bucket,
    key: outKey,
    body: webp,
    contentType: "image/webp",
    cacheControl: "public, max-age=31536000, immutable",
  });

  await prismaMedia.setThumbReady(job.mediaId, outKey);
  deps.publishJobUpdate?.({ userId: job.userId, mediaId: job.mediaId, field: "thumbState", value: "READY" });

  } finally {
    if (videoTempDir) {
      rm(videoTempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/**
 * Wraps `processThumb` in the shape BullMQ calls, logging the start, the
 * duration, and any failure. A failure is re-thrown, so BullMQ still retries.
 */
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
