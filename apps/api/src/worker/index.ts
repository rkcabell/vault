// File: apps/api/src/worker/index.ts
import "dotenv/config";

import IORedis from "ioredis";
import { Queue, Worker } from "bullmq";

import { prisma } from "@vault/db";
import { s3 } from "../plugins/s3Client.js";
import { createOcrProcessor, isTransientError, type OcrJobData } from "./ocrWorker.js";
import { createThumbProcessor, sanitizeThumbError, type ThumbJob } from "./thumbWorker.js";
import { MediaRepository } from "../repositories/mediaRepository.js";
import { DocumentRepository } from "../repositories/documentRepository.js";
import { buildRedisConnection } from "../lib/config/redis.js";
import { createLogger } from "../lib/logger.js";
import { TextJobError } from "../lib/text/processTextJob.js";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const BUCKET = requiredEnv("S3_BUCKET");

const OCR_QUEUE = process.env.OCR_QUEUE ?? "ocr_queue";
const THUMB_QUEUE = process.env.THUMB_QUEUE ?? "thumb_queue";

async function main () {
  const logger = createLogger("worker");
  const connection = buildRedisConnection(REDIS_URL);
  const ioredis = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });

  const mediaRepository = new MediaRepository(prisma);
  const documentRepository = new DocumentRepository(prisma);

  const ocrLogger = logger.child({ queue: OCR_QUEUE, jobName: "ocr" });
  const thumbLogger = logger.child({ queue: THUMB_QUEUE, jobName: "thumb" });

  const ocrQueue = new Queue<OcrJobData>(OCR_QUEUE, { connection });

  const ocrWorker = new Worker<OcrJobData>(
    OCR_QUEUE,
    createOcrProcessor({
      mediaRepository,
      documentRepository,
      s3,
      bucket: BUCKET,
      enqueueOcr: async (data, opts) => ocrQueue.add("ocr", data, opts),
      logger: ocrLogger,
      queueName: OCR_QUEUE,
    }),
    { connection, concurrency: 1 },
  );

  const thumbWorker = new Worker<ThumbJob>(
    THUMB_QUEUE,
    createThumbProcessor({
      prismaMedia: mediaRepository,
      s3,
      bucket: BUCKET,
      logger: thumbLogger,
      queueName: THUMB_QUEUE,
    }),
    { connection, concurrency: 1 },
  );

  ocrWorker.on("ready", () => ocrLogger.info({ queue: OCR_QUEUE }, "worker ready"));
  thumbWorker.on("ready", () => thumbLogger.info({ queue: THUMB_QUEUE }, "worker ready"));

  ocrWorker.on("failed", async (job, err) => {
    const errorCode =
      err instanceof TextJobError
        ? err.code
        : err instanceof Error && err.name
          ? err.name
          : "UNKNOWN_ERROR";
    const attempts = job?.opts?.attempts ?? 1;
    const isFinal = job ? (job.attemptsMade ?? 0) >= attempts : true;
    const transient = isTransientError(err);

    if (job?.data?.mediaId && isFinal && !transient) {
      try {
        await mediaRepository.setTextState(job.data.mediaId, "ERROR");
        ocrLogger.error(
          {
            jobName: "ocr",
            queue: OCR_QUEUE,
            jobId: job?.id ?? "unknown",
            mediaId: job.data.mediaId,
            userId: job.data.userId ?? null,
            durationMs: job?.processedOn ? Date.now() - job.processedOn : undefined,
            errorCode,
          },
          "ocr job failed (marked ERROR)",
        );
      } catch (updateErr) {
        ocrLogger.error(
          {
            jobName: "ocr",
            queue: OCR_QUEUE,
            jobId: job?.id ?? "unknown",
            mediaId: job.data.mediaId,
            userId: job.data.userId ?? null,
            durationMs: job?.processedOn ? Date.now() - job.processedOn : undefined,
            errorCode: "TEXT_STATE_UPDATE_FAILED",
            err: updateErr,
          },
          "failed to mark textState ERROR",
        );
      }
    }

    ocrLogger.error(
      {
        jobName: "ocr",
        queue: OCR_QUEUE,
        jobId: job?.id ?? "unknown",
        mediaId: job?.data?.mediaId ?? "unknown",
        userId: job?.data?.userId ?? null,
        attempt: job?.attemptsMade ?? 0,
        durationMs: job?.processedOn ? Date.now() - job.processedOn : undefined,
        errorCode,
        err,
      },
      "ocr job failed",
    );
  });

  thumbWorker.on("failed", async (job, err) => {
    const msg = err instanceof Error ? err.message : String(err);
    const attempts = job?.opts?.attempts ?? 1;
    const isFinal = job ? (job.attemptsMade ?? 0) >= attempts : true;
    const reason = sanitizeThumbError(err);

    if (job?.data?.mediaId && isFinal) {
      try {
        await mediaRepository.setThumbFailed(job.data.mediaId, reason);
      } catch (updateErr) {
        thumbLogger.error(
          {
            jobName: "thumb",
            queue: THUMB_QUEUE,
            jobId: job?.id ?? "unknown",
            mediaId: job.data.mediaId,
            userId: job.data.userId ?? null,
            durationMs: job?.processedOn ? Date.now() - job.processedOn : undefined,
            errorCode: "THUMB_STATE_UPDATE_FAILED",
            err: updateErr,
          },
          "failed to mark thumbState FAILED",
        );
      }
    }

    thumbLogger.error(
      {
        jobName: "thumb",
        queue: THUMB_QUEUE,
        jobId: job?.id ?? "unknown",
        mediaId: job?.data?.mediaId ?? "unknown",
        userId: job?.data?.userId ?? null,
        attempt: job?.attemptsMade ?? 0,
        durationMs: job?.processedOn ? Date.now() - job.processedOn : undefined,
        errorCode: msg,
        err,
      },
      "thumb job failed",
    );
  });

  ocrWorker.on("error", err =>
    ocrLogger.error(
      {
        jobName: "ocr",
        queue: OCR_QUEUE,
        errorCode: err instanceof Error && err.name ? err.name : "WORKER_ERROR",
        err,
      },
      "worker error",
    ),
  );
  thumbWorker.on("error", err =>
    thumbLogger.error(
      {
        jobName: "thumb",
        queue: THUMB_QUEUE,
        errorCode: err instanceof Error && err.name ? err.name : "WORKER_ERROR",
        err,
      },
      "worker error",
    ),
  );

  logger.info({ queues: [OCR_QUEUE, THUMB_QUEUE] }, "worker started");

  const shutdown = async () => {
    logger.info("worker shutting down...");
    await Promise.all([ocrWorker.close(), thumbWorker.close()]);
    await ocrQueue.close();
    await ioredis.quit();
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch(err => {
  const logger = createLogger("worker");
  logger.error({ err }, "worker fatal");
  process.exit(1);
});

function requiredEnv (name: string): string {
  const v = process.env[name];
  if (!v) throw new MissingEnvError(name);
  return v;
}

class MissingEnvError extends Error {
  code = "ENV_MISSING";
  constructor (public variable: string) {
    super(`${variable} env var is required`);
    this.name = "MissingEnvError";
  }
}
