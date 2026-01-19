import type { S3Client } from "@aws-sdk/client-s3";
import type { JobsOptions } from "bullmq";
import type { Logger } from "pino";
import type { DocumentRepository } from "../repositories/documentRepository.js";
import type { MediaRepository } from "../repositories/mediaRepository.js";
import { waitUntilObjectExists } from "../adapters/s3ObjectProbe.js";
import {
  processTextJob,
  TextJobError,
  type ProcessTextJobDeps,
} from "../lib/text/processTextJob.js";

export type OcrJobData = {
  mediaId: string;
  storageKey?: string;
  forceOcr?: boolean;
  language?: string;
  rotation?: string;
  userId?: string;
  title?: string;
};

export type OcrProcessingDeps = {
  mediaRepository: MediaRepository;
  documentRepository: DocumentRepository;
  s3: S3Client;
  bucket: string;
  enqueueOcr: (data: OcrJobData, opts?: JobsOptions) => Promise<unknown>;
  logger: Logger;
  queueName: string;
  sleep?: (ms: number) => Promise<unknown>;
  textDeps?: ProcessTextJobDeps;
};

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

export async function processOcrJob (deps: OcrProcessingDeps, data: OcrJobData) {
  const { mediaRepository, documentRepository, s3, bucket, enqueueOcr, logger, sleep } = deps;
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

  const key = storageKey ?? media.storageKey;
  logger.info({ ...logContext, key, mimeType: media.mimeType }, "media loaded");

  const exists = await waitUntilObjectExists(s3, bucket, key, {
    maxTries: 8,
    baseDelayMs: 1000,
    sleep,
  });
  if (!exists) {
    logger.warn({ ...logContext, key }, "source not ready");
    throw new TextJobError("SOURCE_NOT_READY", `Source not ready for key=${key}`);
  }

  if (media.mimeType?.startsWith("application/pdf") && !forceOcr) {
    try {
      logger.info({ ...logContext, key }, "pdf extraction start");
      const extracted = await processTextJob({
        s3,
        bucket,
        key,
        mimeType: media.mimeType,
        language,
        rotation,
      }, deps.textDeps);

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

      await mediaRepository.setTextState(mediaId, extracted.needsOcr ? "PENDING" : "READY");

      if (extracted.needsOcr) {
        await enqueueOcr(
          { mediaId, storageKey: key, forceOcr: true, language, rotation },
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

  logger.info({ ...logContext, key }, "OCR fallback");
  if (sleep) await sleep(1000);

  const ocrResult = await processTextJob({
    s3,
    bucket,
    key,
    mimeType: media.mimeType,
    forceOcr: true,
    language,
    rotation,
  }, deps.textDeps);

  await documentRepository.upsertDocument({
    mediaId,
    rawText: ocrResult.rawText,
    pages: ocrResult.pages ?? [],
    textSource: ocrResult.textSource,
  });

  await mediaRepository.setTextState(mediaId, "READY");

  logger.info({ ...logContext, key }, "processed OCR");
}

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
