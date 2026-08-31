import "dotenv/config";

import { cpus } from "node:os";
import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";

import { prisma } from "@vault/db";
import { createWorkerStorage, workerBucket, workerAllowedRoots } from "./storageFromEnv.js";
import { readLowMemoryPreference } from "./workerPrefs.js";
import { createOcrProcessor, type OcrJobData } from "./ocrWorker.js";
import { MediaRepository } from "../repositories/mediaRepository.js";
import { DocumentRepository } from "../repositories/documentRepository.js";
import { PreferencesRepository } from "../repositories/preferencesRepository.js";
import { PreferencesService } from "../services/preferencesService.js";
import { DEFAULT_PREFERENCES } from "@vault/types";
import { buildRedisConnection } from "../lib/config/redis.js";
import { createLogger } from "../lib/logger.js";
import { TextJobError } from "../lib/text/processTextJob.js";
import { markStalledJobs } from "../services/stallDetectionService.js";
import { OCR_QUEUE, enqueueOcrJob } from "../queues/enqueueOcr.js";

/**
 * Entry point for the tier-2 OCR worker, which runs ocrmypdf and Tesseract.
 * Nothing reaches `ocr_queue` without `forceOcr` set. Each job is a subprocess
 * taking about one core and up to a gigabyte of memory for seconds to tens of
 * minutes, so the pool stays near the core count however deep the backlog: a
 * larger one buys context switching and out-of-memory kills, not throughput.
 */

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const BUCKET = workerBucket();

// Env var takes precedence; falls back to the DB preference set via the web UI.
const LOW_MEMORY = process.env.LOW_MEMORY === "true" || process.env.LOW_MEMORY === "1"
  || await readLowMemoryPreference(prisma);

// Capped at 4 whatever the core count: past that, memory and disk limit it
// rather than cores, and a 32-core machine does not have 32 GB to spare for
// Tesseract. OCR_CONCURRENCY overrides it.
const OCR_CONCURRENCY      = parseEnvNumber(
  "OCR_CONCURRENCY",
  Math.max(1, Math.floor(Math.min(4, cpus().length - 1) / (LOW_MEMORY ? 2 : 1))),
);
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
  const preferencesService = new PreferencesService(new PreferencesRepository(prisma));
  const storage            = createWorkerStorage();

  const ocrLogger = logger.child({ queue: OCR_QUEUE, jobName: "ocr" });
  const ocrQueue  = new Queue<OcrJobData>(OCR_QUEUE, { connection });

  const ocrWorker = new Worker<OcrJobData>(
    OCR_QUEUE,
    createOcrProcessor({
      mediaRepository,
      documentRepository,
      storage,
      bucket: BUCKET,
      allowedRoots: workerAllowedRoots(),
      // Self-enqueue: a forced job that turns out to still need a handoff
      // (retry after a transient read failure) goes back on this same queue.
      enqueueOcr: async (data, opts) => enqueueOcrJob(ocrQueue, data, opts),
      getOcrMode: async userId =>
        userId ? (await preferencesService.getPreferences(userId)).ocrMode : DEFAULT_PREFERENCES.ocrMode,
      getOcrTimeoutCapMinutes: async userId =>
        userId ? (await preferencesService.getPreferences(userId)).ocrTimeoutCapMinutes : DEFAULT_PREFERENCES.ocrTimeoutCapMinutes,
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

  if (LOW_MEMORY) logger.info({ concurrency: OCR_CONCURRENCY }, "low-memory mode: ocr concurrency halved");

  ocrWorker.on("ready", () =>
    ocrLogger.info({ queue: OCR_QUEUE, concurrency: OCR_CONCURRENCY }, "ocr worker ready"),
  );

  // Stall detection watches text state only, so it belongs to a text-side
  // process. worker/text.ts runs it too; the sweep can be repeated safely.
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

function parseEnvNumber(name: string, fallback: number): number {
  const raw    = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}
