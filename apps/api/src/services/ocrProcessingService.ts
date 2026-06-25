import type { JobsOptions } from "bullmq";
import type { Logger } from "pino";
import type { DocumentRepository } from "../repositories/documentRepository.js";
import type { MediaRepository } from "../repositories/mediaRepository.js";
import type { StorageAdapter } from "../adapters/storage/types.js";
import { waitUntilObjectExists } from "../adapters/s3ObjectProbe.js";
import {
  processTextJob,
  TextJobError,
  type ProcessTextJobDeps,
} from "../lib/text/processTextJob.js";
import {
  ocrSupported,
  isPlainTextMime,
  exceedsTextSize,
  TEXT_TOO_LARGE_REASON,
} from "../lib/media/processingSupport.js";

export type OcrJobData = {
  mediaId: string;
  storageKey?: string;
  forceOcr?: boolean;
  language?: string;
  rotation?: string;
  userId?: string;
  title?: string;
  sourcePath?: string; // set for in-place indexed items; source read read-only from disk
  allowedRoots?: string[]; // snapshotted from user preferences at enqueue time
};

export type OcrProcessingDeps = {
  mediaRepository: MediaRepository;
  documentRepository: DocumentRepository;
  storage: StorageAdapter;
  bucket: string;
  /** Configured INDEX_ALLOWED_ROOTS; required to read in-place sources. Defaults to []. */
  allowedRoots?: string[];
  enqueueOcr: (data: OcrJobData, opts?: JobsOptions) => Promise<unknown>;
  logger: Logger;
  queueName: string;
  sleep?: (ms: number) => Promise<unknown>;
  timeoutMs?: number;
  textDeps?: ProcessTextJobDeps;
  publishJobUpdate?: (
    update: { userId: string; mediaId: string; field: "textState" | "tagsUpdated"; value: "READY" | "ERROR" | "UNSUPPORTED" | "updated" },
  ) => void;
};

/**
 * Return true if the error is likely transient and worth retrying.
 * SOURCE_NOT_READY means the S3 object hasn't propagated yet; the networking
 * and throttling codes come from the AWS SDK. TextJobError codes are matched
 * directly to avoid string-matching on human-readable messages.
 */
function isTransientError (err: unknown) {
  const msg =
    err instanceof TextJobError
      ? err.code
      : err instanceof Error
        ? err.message
        : typeof err === "string"
          ? err
          : "";
  return (
    msg.includes("SOURCE_NOT_READY") ||
    msg.includes("NetworkingError") ||
    msg.includes("Timeout") ||
    msg.includes("Throttling")
  );
}


/**
 * Execute a single OCR job. The two-stage flow:
 *
 * Stage 1 — Native PDF extraction (PDF MIME, forceOcr = false):
 *   Attempts text extraction with pdf.js. If the PDF has embedded text,
 *   textState → READY and we're done. If the PDF appears to be a scan
 *   (needsOcr = true), textState stays PENDING and a new job is enqueued
 *   with forceOcr = true for Stage 2. A pdf.js error (other than
 *   SOURCE_NOT_READY) also falls through to Stage 2.
 *
 * Stage 2 — OCRmyPDF (images, forceOcr = true, or pdf.js fallback):
 *   Runs ocrmypdf in a temp directory, wrapping images in a PDF first.
 *   The resulting OCR'd PDF is then parsed by pdf.js to extract text.
 *   textState → READY on success.
 *
 * An AbortController enforces a per-file timeout (see computeOcrTimeout).
 * Cancellation is detected via textState = ERROR/UNSUPPORTED before processing
 * starts and after each state write.
 */
export async function processOcrJob (deps: OcrProcessingDeps, data: OcrJobData) {
  const { mediaRepository, documentRepository, storage, bucket, enqueueOcr, logger, sleep } = deps;
  const { mediaId, storageKey, forceOcr, language, rotation } = data;

  const logContext = {
    jobName: "ocr",
    queue: deps.queueName,
    mediaId,
    userId: data.userId ?? null,
  };

  const media = await mediaRepository.findForOcr(mediaId);

  if (!media) {
    logger.warn({ ...logContext }, "media not found");
    return;
  }

  if (media.textState === "ERROR" || media.textState === "UNSUPPORTED") {
    logger.info({ ...logContext }, "ocr cancelled before start");
    return;
  }

  const mimeTypeLower = media.mimeType?.toLowerCase() ?? "";
  if (!ocrSupported(mimeTypeLower)) {
    logger.info({ ...logContext, mimeType: media.mimeType }, "text extraction skipped: unsupported mime type");
    await mediaRepository.setTextState(mediaId, "UNSUPPORTED");
    if (data.userId) {
      deps.publishJobUpdate?.({ userId: data.userId, mediaId, field: "textState", value: "UNSUPPORTED" });
    }
    return;
  }

  // Plain-text files are read whole into memory; skip ones too large to avoid
  // OOM and to keep the search vector under Postgres's tsvector ceiling.
  if (isPlainTextMime(mimeTypeLower) && exceedsTextSize(media.sizeBytes)) {
    logger.info({ ...logContext, sizeBytes: media.sizeBytes, reason: TEXT_TOO_LARGE_REASON }, "text extraction skipped: file too large");
    await mediaRepository.setTextState(mediaId, "UNSUPPORTED");
    if (data.userId) {
      deps.publishJobUpdate?.({ userId: data.userId, mediaId, field: "textState", value: "UNSUPPORTED" });
    }
    return;
  }

  const key = storageKey ?? media.storageKey;
  // In-place indexed items read their original from disk (read-only), not from
  // managed storage. The DB row is the source of truth for the path.
  const sourcePath = media.sourcePath ?? undefined;
  const allowedRoots = data.allowedRoots?.length ? data.allowedRoots : (deps.allowedRoots ?? []);
  const timeoutMs = deps.timeoutMs ?? computeOcrTimeout(media.sizeBytes ?? 0);
  logger.info({ ...logContext, key, sourcePath, mimeType: media.mimeType, timeoutMs }, "media loaded");

  const abortController = new AbortController();
  const abortTimer = setTimeout(() => abortController.abort(), timeoutMs);

  try {

  // S3 objects can lag after upload; in-place files already exist on disk, so
  // the propagation probe only applies to managed sources.
  if (!sourcePath) {
    const exists = await waitUntilObjectExists(storage, bucket, key, {
      maxTries: 8,
      baseDelayMs: 1000,
      sleep,
    });
    if (!exists) {
      logger.warn({ ...logContext, key }, "source not ready");
      throw new TextJobError("SOURCE_NOT_READY", `Source not ready for key=${key}`);
    }
  }

  if (media.mimeType?.startsWith("application/pdf") && !forceOcr) {
    try {
      logger.info({ ...logContext, key }, "pdf extraction start");
      const extracted = await processTextJob({
        storage,
        bucket,
        key,
        sourcePath,
        allowedRoots,
        mimeType: media.mimeType,
        language,
        rotation,
        abortSignal: abortController.signal,
      }, { ...deps.textDeps, logger });

      logger.info(
        {
          ...logContext,
          key,
          chars: extracted.rawText.length,
          needsOcr: extracted.needsOcr,
        },
        "pdf extraction done",
      );

      await documentRepository.upsertDocument({
        mediaId,
        rawText: extracted.rawText,
        pages: extracted.pages ?? [],
        textSource: extracted.textSource,
      });

      const stateSet = await mediaRepository.setTextState(mediaId, extracted.needsOcr ? "PENDING" : "READY");
      if (!stateSet) {
        logger.info({ ...logContext }, "ocr cancelled after pdf extraction");
        return;
      }

      if (!extracted.needsOcr) {
        if (extracted.rawText.length > 0) {
          await mediaRepository.addTagIfAbsent(mediaId, "has-text");
          if (data.userId) {
            deps.publishJobUpdate?.({ userId: data.userId, mediaId, field: "tagsUpdated", value: "updated" });
          }
        }
        if (data.userId) {
          deps.publishJobUpdate?.({ userId: data.userId, mediaId, field: "textState", value: "READY" });
        }
      }

      if (extracted.needsOcr) {
        await enqueueOcr(
          { mediaId, storageKey: key, sourcePath, forceOcr: true, language, rotation, userId: data.userId, title: data.title },
          { attempts: 1 },
        );
        logger.info({ ...logContext }, "queued OCR fallback");
      }

      return;
    } catch (err) {
      if (err instanceof TextJobError && err.code === "SOURCE_NOT_READY") {
        logger.warn({ ...logContext, key, err }, "pdf source not ready");
        throw err;
      }
      logger.warn({ ...logContext, key, err }, "pdf text extraction failed; falling back to OCR");
    }
  }

  // Plain text returns immediately from processTextJob (no ocrmypdf); only the
  // real OCR path needs the warm-up delay.
  const isText = isPlainTextMime(mimeTypeLower);
  logger.info({ ...logContext, key }, isText ? "text extraction" : "OCR fallback");
  if (sleep && !isText) await sleep(1000);

  const ocrResult = await processTextJob({
    storage,
    bucket,
    key,
    sourcePath,
    allowedRoots,
    mimeType: media.mimeType,
    forceOcr: true,
    language,
    rotation,
    abortSignal: abortController.signal,
  }, { ...deps.textDeps, logger });

  await documentRepository.upsertDocument({
    mediaId,
    rawText: ocrResult.rawText,
    pages: ocrResult.pages ?? [],
    textSource: ocrResult.textSource,
  });

  const stateSet = await mediaRepository.setTextState(mediaId, "READY");
  if (!stateSet) {
    logger.info({ ...logContext }, "ocr cancelled after processing");
    return;
  }

  if (ocrResult.rawText.length > 0) {
    await mediaRepository.addTagIfAbsent(mediaId, "has-text");
    if (data.userId) {
      deps.publishJobUpdate?.({ userId: data.userId, mediaId, field: "tagsUpdated", value: "updated" });
    }
  }

  if (data.userId) {
    deps.publishJobUpdate?.({ userId: data.userId, mediaId, field: "textState", value: "READY" });
  }

  logger.info({ ...logContext, key }, "processed OCR");

  } finally {
    clearTimeout(abortTimer);
  }
}

/**
 * Wrap `processOcrJob` in the BullMQ worker callback signature.
 * Logs start, completion (with duration), and failure with a structured
 * errorCode. Re-throws so BullMQ can apply retry/backoff.
 */
export function createOcrProcessor (deps: OcrProcessingDeps) {
  return async (job: {
    data: OcrJobData;
    id?: string;
    opts?: { attempts?: number };
    attemptsMade?: number;
  }) => {
    const start = Date.now();
    const context = {
      jobName: "ocr" as const,
      queue: deps.queueName,
      jobId: job.id ?? "unknown",
      mediaId: job.data.mediaId,
      userId: job.data.userId ?? null,
      attempt: job.attemptsMade ?? 0,
    };
    deps.logger.info(context, "ocr job started");
    try {
      await processOcrJob(deps, job.data);
      deps.logger.info({ ...context, durationMs: Date.now() - start }, "ocr job completed");
    } catch (err) {
      const errorCode =
        err instanceof TextJobError
          ? err.code
          : err instanceof Error && err.name
            ? err.name
            : "UNKNOWN_ERROR";
      deps.logger.error(
        { ...context, durationMs: Date.now() - start, errorCode, err },
        "ocr job failed",
      );

      throw err;
    }
  };
}

export { isTransientError };

/**
 * Timeout = 60s base + 30s per MB, capped at 10 minutes.
 *
 * Rationale:
 *   - 60s covers fixed overhead (process startup, S3 download, pdf.js).
 *   - ocrmypdf processes roughly 1 MB (≈2 scanned pages) in ~15s at normal load;
 *     30s/MB gives a 2× safety margin.
 *   - 10 min cap prevents runaway locks on unexpectedly large or corrupt files.
 *
 * Example timeouts:
 *   64 KB  → ~62s    (small image)
 *   1 MB   → ~90s
 *   5 MB   → ~210s
 *   20 MB+ → 600s    (cap)
 */
export function computeOcrTimeout (sizeBytes: number): number {
  const BASE_MS = 60_000;
  const PER_MB_MS = 30_000;
  const MAX_MS = 10 * 60_000;
  const sizeMb = sizeBytes / (1024 * 1024);
  return Math.min(MAX_MS, Math.round(BASE_MS + sizeMb * PER_MB_MS));
}
