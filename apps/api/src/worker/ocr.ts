// Entry point for the OCR worker process.
// Run independently of the thumbnail worker so a crashing OCR job
// cannot block thumbnail processing (and vice-versa).
import "dotenv/config";

import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";

import { prisma } from "@vault/db";
import { s3 } from "../plugins/s3Client.js";
import { readLowMemoryPreference } from "./workerPrefs.js";
import { createOcrProcessor, type OcrJobData } from "./ocrWorker.js";
import { MediaRepository } from "../repositories/mediaRepository.js";
import { DocumentRepository } from "../repositories/documentRepository.js";
import { buildRedisConnection } from "../lib/config/redis.js";
import { createLogger } from "../lib/logger.js";
import { TextJobError } from "../lib/text/processTextJob.js";
import { markStalledJobs } from "../services/stallDetectionService.js";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const BUCKET = requiredEnv("S3_BUCKET");

// Env var takes precedence; falls back to the DB preference set via the web UI.
const LOW_MEMORY = process.env.LOW_MEMORY === "true" || process.env.LOW_MEMORY === "1"
  || await readLowMemoryPreference(prisma);

const OCR_QUEUE            = process.env.OCR_QUEUE ?? "ocr_queue";
const OCR_CONCURRENCY      = parseEnvNumber("OCR_CONCURRENCY", LOW_MEMORY ? 2 : 4);
const OCR_LOCK_DURATION_MS = parseEnvNumber("OCR_LOCK_DURATION_MS", 30 * 60 * 1000);
const OCR_LOCK_RENEW_MS    = parseEnvNumber(
  "OCR_LOCK_RENEW_MS",
  Math.max(30_000, Math.floor(OCR_LOCK_DURATION_MS / 2)),
);
const OCR_STALLED_INTERVAL_MS  = parseEnvNumber("OCR_STALLED_INTERVAL_MS", 60 * 1000);
const STALL_CHECK_INTERVAL_MS  = parseEnvNumber("STALL_CHECK_INTERVAL_MS", 10 * 60 * 1000);

async function main() {
  const logger     = createLogger("worker-ocr");
  const connection = buildRedisConnection(REDIS_URL);

  const publisher = new IORedis(REDIS_URL);
  publisher.on("error", err => logger.warn({ err }, "publisher redis error"));

  const publishJobUpdate = (update: { userId: string; mediaId: string; field: string; value: string }) => {
    publisher
      .publish(`media-events:${update.userId}`, JSON.stringify({ mediaId: update.mediaId, field: update.field, value: update.value }))
      .catch(err => logger.warn({ err }, "failed to publish job update"));
  };

  const mediaRepository    = new MediaRepository(prisma);
  const documentRepository = new DocumentRepository(prisma);

  const ocrLogger = logger.child({ queue: OCR_QUEUE, jobName: "ocr" });
  const ocrQueue  = new Queue<OcrJobData>(OCR_QUEUE, { connection });

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
      publishJobUpdate,
    }),
    {
      connection,
      concurrency: OCR_CONCURRENCY,
      lockDuration: OCR_LOCK_DURATION_MS,
      lockRenewTime: OCR_LOCK_RENEW_MS,
      stalledInterval: OCR_STALLED_INTERVAL_MS,
    },
  );

  if (LOW_MEMORY) logger.info("low-memory mode: ocr concurrency capped at 2");

  ocrWorker.on("ready", () =>
    ocrLogger.info({ queue: OCR_QUEUE, concurrency: OCR_CONCURRENCY }, "ocr worker ready"),
  );

  // Stall detection lives here because it monitors OCR/text state only.
  const stallLogger  = logger.child({ component: "stall-detection" });
  const runStallCheck = () =>
    markStalledJobs(mediaRepository, stallLogger).catch(err =>
      stallLogger.error({ err }, "stall detection failed"),
    );
  void runStallCheck();
  const stallInterval = setInterval(runStallCheck, STALL_CHECK_INTERVAL_MS);

  ocrWorker.on("failed", async (job, err) => {
    const errorCode =
      err instanceof TextJobError
        ? err.code
        : err instanceof Error && err.name
          ? err.name
          : "UNKNOWN_ERROR";
    const attempts = job?.opts?.attempts ?? 1;
    const isFinal  = job ? (job.attemptsMade ?? 0) >= attempts : true;

    if (job?.data?.mediaId && isFinal) {
      try {
        await mediaRepository.setTextState(job.data.mediaId, "ERROR");
        if (job.data.userId) {
          publishJobUpdate({ userId: job.data.userId, mediaId: job.data.mediaId, field: "textState", value: "ERROR" });
        }
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

  logger.info({ queue: OCR_QUEUE, concurrency: OCR_CONCURRENCY }, "ocr worker started");

  const shutdown = async () => {
    logger.info("ocr worker shutting down...");
    clearInterval(stallInterval);
    await ocrWorker.close();
    await ocrQueue.close();
    await publisher.quit();
  };

  process.on("SIGINT",  () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch(err => {
  const logger = createLogger("worker-ocr");
  logger.error({ err }, "ocr worker fatal");
  process.exit(1);
});

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new MissingEnvError(name);
  return v;
}

function parseEnvNumber(name: string, fallback: number): number {
  const raw    = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

class MissingEnvError extends Error {
  code = "ENV_MISSING";
  constructor(public variable: string) {
    super(`${variable} env var is required`);
    this.name = "MissingEnvError";
  }
}
