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
import { waitUntilObjectExists } from "../../adapters/s3ObjectProbe.js";
import { looksLikeHeic, looksLikeMp4, looksLikePdf, looksLikePng } from "../../lib/fileSignatures.js";
import { renderPdfThumbnail } from "./renderPdfThumbnail.js";
import { renderVideoThumbnail } from "./renderVideoThumbnail.js";
import { renderHeicThumbnail } from "./renderHeicThumbnail.js";
import { computeThumbKey, type ThumbJob } from "../../queues/enqueueThumbnail.js";
import { extractMetadataFromBuffer } from "../media/metadata/extractMediaMetadata.js";
import { exceedsThumbnailSize, THUMBNAIL_TOO_LARGE_REASON } from "../../lib/media/processingSupport.js";

type PrefsLookup = { getPreferences: (userId: string) => Promise<{ extractMetadata?: boolean; detectDuplicates?: boolean }> };

export type ThumbDeps = {
  prismaMedia: MediaRepository;
  metadataRepository?: MediaMetadataRepository;
  preferencesService?: PrefsLookup;
  storage: StorageAdapter;
  bucket: string;
  /** Configured INDEX_ALLOWED_ROOTS; required to read in-place sources. Defaults to []. */
  allowedRoots?: string[];
  logger: Logger;
  queueName: string;
  publishJobUpdate?: (update: { userId: string; mediaId: string; field: "thumbState"; value: "READY" | "FAILED" }) => void;
};

/** Stored when the error message is empty after sanitization. */
const THUMB_ERROR_FALLBACK = "thumbnail_failed";
/** Maximum characters persisted in thumbError to keep DB values bounded. */
const MAX_THUMB_ERROR_LENGTH = 160;

/**
 * Convert any thrown value to a short, single-line string safe for DB storage.
 * Collapses whitespace, trims, truncates to MAX_THUMB_ERROR_LENGTH, and falls
 * back to a generic sentinel when the message would be empty.
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
 * Resize and encode an image buffer to WebP.
 * `rotate()` with no argument applies EXIF auto-rotation.
 * `fit: "inside"` preserves aspect ratio; `withoutEnlargement` prevents
 * upscaling images that are already smaller than `size`.
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
  /** Return true if this handler should process the given file. First match wins. */
  detect: (mimeType: string, buffer: Buffer) => boolean;
  /** Render a high-resolution intermediate PNG from the source buffer. */
  render: (buffer: Buffer, targetWidth: number) => Promise<Buffer>;
};

/**
 * Registry of format-specific thumbnail renderers, checked in order.
 * Order matters: HEIC must precede video because some HEIC files share
 * MP4 magic bytes and would otherwise be misclassified.
 *
 * To add a new format: import its renderer and append an entry here.
 * No changes to processThumb are needed.
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
    // Note: when videoPath is available (pre-streamed), thumbnailService calls renderVideoThumbnail directly.
  },
  {
    label: "pdf",
    detect: (mime, buf) => mime.includes("pdf") || looksLikePdf(buf),
    render: (buf, w) => renderPdfThumbnail({ pdf: buf, targetWidth: w }),
  },
];

/**
 * Core thumbnail processing logic for a single job.
 *
 * Flow:
 * 1. Idempotency check — if thumbnailKey already matches outKey and state is
 *    READY, return early. If state is wrong (e.g. PENDING after a crash),
 *    repair it in place.
 * 2. Wait for the source object to appear in S3 (up to 4 probes).
 * 3. Opportunistically extract and persist file metadata from the buffer
 *    (non-fatal; a metadata error never fails the thumb job).
 * 4. Match the file against FORMAT_HANDLERS (first match wins) and render a
 *    high-resolution intermediate PNG. Generic images pass through unchanged.
 * 5. Encode the intermediate PNG to WebP at `size` px and upload to S3.
 * 6. Mark thumbState READY in the DB and publish a real-time update.
 *
 * Format-specific render failures (video, PDF, HEIC) set thumbState FAILED
 * and return without throwing, since the error is permanent and retrying
 * would produce the same result. Sharp failures and S3 errors propagate
 * so BullMQ can retry them.
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

  // Skip files too large to load into memory. The worker reads the whole source
  // into a Buffer (ffmpeg/sharp need it in memory too), which can't exceed Node's
  // ~2 GiB Buffer limit — attempting it only burns a queue slot and fails. Mark
  // FAILED with a clear reason so the UI shows a placeholder instead of a stuck
  // PENDING. Permanent (the size won't change), so return rather than throw.
  if (exceedsThumbnailSize(existing?.sizeBytes)) {
    await prismaMedia.setThumbFailed(job.mediaId, THUMBNAIL_TOO_LARGE_REASON);
    deps.publishJobUpdate?.({ userId: job.userId, mediaId: job.mediaId, field: "thumbState", value: "FAILED" });
    logger.info(
      { ...logContext, sizeBytes: existing?.sizeBytes, reason: THUMBNAIL_TOO_LARGE_REASON, durationMs: Date.now() - startedAt },
      "thumbnail skipped: file too large",
    );
    return;
  }

  // S3 objects can lag after upload; in-place files already exist on disk, so
  // the propagation probe only applies to managed sources.
  if (!sourcePath) {
    const exists = await waitUntilObjectExists(storage, bucket, storageKey, { maxTries: 4 });
    if (!exists) throw new Error("SOURCE_NOT_READY");
  }

  const mimeType = existing?.mimeType ?? "";
  const isVideo = mimeType.startsWith("video/");

  // For video files, stream directly from S3 to a temp file to avoid holding
  // the full source in memory while ffmpeg also needs it on disk. For all other
  // formats download to buffer as before.
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

  // Fetch user preferences once — used for extractMetadata and detectDuplicates gates.
  const prefs = deps.preferencesService && job.userId
    ? await deps.preferencesService.getPreferences(job.userId).catch(() => null)
    : null;

  // Extract and persist file metadata from the buffer we already have.
  // Non-fatal: a metadata failure must never fail the thumbnail job.
  // Skipped when the user has disabled extractMetadata (privacy — avoids storing EXIF/GPS).
  if (deps.metadataRepository && mimeType && prefs?.extractMetadata !== false) {
    extractMetadataFromBuffer(original, mimeType)
      .then((meta) => {
        if (meta) return deps.metadataRepository!.upsert(job.mediaId, meta);
      })
      .catch((err: unknown) => logger.warn({ err, mediaId: job.mediaId }, "metadata extraction failed"));
  }

  // Compute SHA-256 hash, store it, and tag duplicates when detectDuplicates is enabled.
  // Non-fatal: hash/duplicate failures must never fail the thumbnail job.
  try {
    const contentHash = crypto.createHash("sha256").update(original).digest("hex");
    await prismaMedia.setContentHash(job.mediaId, contentHash);
    if (prefs?.detectDuplicates && job.userId) {
      const existing2 = await prismaMedia.findDuplicateByHash(job.userId, contentHash, job.mediaId);
      if (existing2) {
        await Promise.all([
          prismaMedia.addTagIfAbsent(job.mediaId, "duplicate"),
          prismaMedia.addTagIfAbsent(existing2.id, "duplicate"),
        ]);
      }
    }
  } catch (err: unknown) {
    logger.warn({ err, mediaId: job.mediaId }, "hash/duplicate check failed");
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
 * Wrap `processThumb` in the BullMQ worker callback signature.
 * Logs job start, completion (with duration), and failure (re-throws so BullMQ
 * can apply retry/backoff logic).
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
