import type { JobsOptions } from "bullmq";
import type { Logger } from "pino";
import { DEFAULT_PREFERENCES, type OcrMode } from "@vault/types";
import type { DocumentRepository } from "../repositories/documentRepository.js";
import type { MediaRepository } from "../repositories/mediaRepository.js";
import type { StorageAdapter } from "../adapters/storage/types.js";
import type { PdfTextPage } from "./pdf/extractPdfText.js";
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
import { OCR_PRIORITY_BACKGROUND } from "../queues/enqueueOcr.js";

export type OcrJobData = {
  mediaId: string;
  storageKey?: string | null;
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
  /** The user's allowed roots. Needed to read a source on their own drive. */
  allowedRoots?: string[];
  /**
   * Hands a job to tier 2. It has to target `ocr_queue` even when the caller is
   * draining `text_queue`: the split is worth nothing if the cheap queue runs
   * Tesseract itself.
   */
  enqueueOcr: (data: OcrJobData, opts?: JobsOptions) => Promise<unknown>;
  /**
   * The user's `ocrMode` preference, read per job. It governs tier 2 only;
   * tier-1 extraction always runs. Omitted, the default preference applies.
   */
  getOcrMode?: (userId?: string) => Promise<OcrMode>;
  /**
   * The user's `ocrTimeoutCapMinutes` preference, read per job. It bounds how
   * long a Tesseract run may take before it is aborted. Omitted, the default
   * preference applies.
   */
  getOcrTimeoutCapMinutes?: (userId?: string) => Promise<number>;
  logger: Logger;
  queueName: string;
  sleep?: (ms: number) => Promise<unknown>;
  timeoutMs?: number;
  textDeps?: ProcessTextJobDeps;
  publishJobUpdate?: (
    update: { userId: string; mediaId: string; field: "textState" | "tagsUpdated"; value: "READY" | "ERROR" | "UNSUPPORTED" | "NEEDS_OCR" | "updated" },
  ) => void;
};

/**
 * True when the error looks transient and the job is worth retrying.
 * SOURCE_NOT_READY means the source could not be read yet, which on a network
 * mount is often momentary. Codes are matched rather than message text.
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
    msg.includes("Timeout")
  );
}


/**
 * Runs one text-extraction job. This one processor drains both queues, and
 * `forceOcr` alone decides which tier runs.
 *
 * Tier 1 is native pdf.js extraction and direct plain-text reads: milliseconds,
 * no subprocess. A PDF with a text layer reaches READY here. A scan, a PDF
 * pdf.js could not read, and an image all park at NEEDS_OCR and are handed to
 * tier 2 rather than run here.
 *
 * Tier 2 runs ocrmypdf in a temporary directory, wrapping an image in a PDF
 * first, then reads the result with pdf.js. It is reached only when the user
 * asked for it, or `ocrMode` is `background`.
 *
 * A per-file timeout aborts a run that takes too long. A cancellation shows up
 * as textState ERROR or UNSUPPORTED, checked before the work starts and after
 * each state write.
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

  // A plain-text file is read whole into memory, so a large one is skipped
  // both to bound memory and to keep the search vector inside what Postgres
  // allows.
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

  // Copies another row's extracted text for a byte-identical file rather than
  // extracting again. It applies to both tiers, and saves the most on a forced
  // one, where it skips a whole Tesseract run.
  //
  // It is not gated on detectDuplicates: that preference controls tagging, and
  // turning it off is no reason to extract the same bytes twice. A miss or a
  // failed lookup falls through to normal extraction, so this never fails a job.
  if (media.contentHash) {
    try {
      const twin = await mediaRepository.findReusableDocument(media.userId, media.contentHash, mediaId);
      if (twin) {
        await documentRepository.upsertDocument({
          mediaId,
          rawText: twin.rawText,
          pages: (twin.pages as PdfTextPage[] | null) ?? null,
          textSource: twin.textSource ?? "NATIVE",
        });
        const stateSet = await mediaRepository.setTextState(mediaId, "READY");
        if (!stateSet) {
          logger.info({ ...logContext }, "ocr cancelled after reuse");
          return;
        }
        if (twin.rawText.length > 0) {
          await mediaRepository.addTagIfAbsent(mediaId, "has-text");
          if (data.userId) {
            deps.publishJobUpdate?.({ userId: data.userId, mediaId, field: "tagsUpdated", value: "updated" });
          }
        }
        if (data.userId) {
          deps.publishJobUpdate?.({ userId: data.userId, mediaId, field: "textState", value: "READY" });
        }
        logger.info({ ...logContext, twinMediaId: twin.id }, "text reused from identical file");
        return;
      }
    } catch (err: unknown) {
      logger.warn({ ...logContext, err }, "text reuse check failed; extracting instead");
    }
  }

  const capMinutes = (await deps.getOcrTimeoutCapMinutes?.(data.userId)) ?? DEFAULT_PREFERENCES.ocrTimeoutCapMinutes;
  const timeoutMs = deps.timeoutMs ?? computeOcrTimeout(media.sizeBytes ?? 0, capMinutes * 60_000);
  logger.info({ ...logContext, key, sourcePath, mimeType: media.mimeType, timeoutMs }, "media loaded");

  const abortController = new AbortController();
  const abortTimer = setTimeout(() => abortController.abort(), timeoutMs);

  /**
   * Tier 1 has established that this file needs Tesseract. Under `background`
   * the work goes to `ocr_queue`; under `onDemand` or `off` the row stays
   * parked, and the library shows it.
   *
   * Always an enqueue, never an inline run: this is a tier-1 job, and running
   * ocrmypdf here would hold a high-concurrency slot for the whole run.
   */
  const handOffToTier2 = async () => {
    const mode = (await deps.getOcrMode?.(data.userId)) ?? DEFAULT_PREFERENCES.ocrMode;
    if (mode === "background") {
      await enqueueOcr(
        { mediaId, storageKey: key, sourcePath, forceOcr: true, language, rotation, userId: data.userId, title: data.title, allowedRoots },
        { priority: OCR_PRIORITY_BACKGROUND },
      );
      logger.info({ ...logContext, ocrMode: mode }, "queued OCR fallback");
    } else {
      // onDemand / off: the row stays at NEEDS_OCR and is surfaced in the
      // library, where the user can run one file or the whole backlog.
      logger.info({ ...logContext, ocrMode: mode }, "OCR deferred (needs scan OCR)");
    }
  };

  try {

  // A filesystem write becomes visible the moment its atomic rename completes.
  // A missing source surfaces as SOURCE_NOT_READY from the read below.
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

      // A scan parks at NEEDS_OCR rather than PENDING. Stall detection would
      // otherwise flip a row waiting in a long OCR backlog to ERROR after
      // fifteen minutes with nothing having failed. It is also the distinction
      // the library needs to show "not started" apart from "needs Tesseract",
      // which is what a user decides to opt into.
      const stateSet = await mediaRepository.setTextState(mediaId, extracted.needsOcr ? "NEEDS_OCR" : "READY");
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
        await handOffToTier2();
        if (data.userId) {
          deps.publishJobUpdate?.({ userId: data.userId, mediaId, field: "textState", value: "NEEDS_OCR" });
        }
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

  const isText = isPlainTextMime(mimeTypeLower);

  // Anything left that is not plain text needs Tesseract: an image, or a PDF
  // whose text layer could not be read. It parks and hands off like the scanned
  // PDF above, so indexing a photo library does not silently start an OCR run
  // over every image in it. With forceOcr this is the tier-2 job, and it falls
  // straight through.
  if (!isText && !forceOcr) {
    const parked = await mediaRepository.setTextState(mediaId, "NEEDS_OCR");
    if (!parked) {
      logger.info({ ...logContext }, "ocr cancelled before deferral");
      return;
    }
    await handOffToTier2();
    if (data.userId) {
      deps.publishJobUpdate?.({ userId: data.userId, mediaId, field: "textState", value: "NEEDS_OCR" });
    }
    return;
  }

  // Plain text returns immediately from processTextJob (no ocrmypdf); only the
  // real OCR path needs the warm-up delay.
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
 * Wraps `processOcrJob` in the shape BullMQ calls, logging the start, the
 * duration, and any failure. A failure is re-thrown, so BullMQ still retries.
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
 * Returns 60 seconds plus 30 per megabyte, up to `capMs`.
 *
 * The base covers process startup, the source read, and pdf.js. ocrmypdf gets
 * through about a megabyte, roughly two scanned pages, in 15 seconds under
 * normal load, so 30 leaves double the margin. The cap stops a corrupt file
 * holding a slot indefinitely.
 */
export function computeOcrTimeout (sizeBytes: number, capMs: number = DEFAULT_PREFERENCES.ocrTimeoutCapMinutes * 60_000): number {
  const BASE_MS = 60_000;
  const PER_MB_MS = 30_000;
  const sizeMb = sizeBytes / (1024 * 1024);
  return Math.min(capMs, Math.round(BASE_MS + sizeMb * PER_MB_MS));
}
