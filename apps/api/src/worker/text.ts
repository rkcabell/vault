import "dotenv/config";

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
import { TEXT_QUEUE } from "../queues/enqueueText.js";
import { OCR_QUEUE, enqueueOcrJob } from "../queues/enqueueOcr.js";

/**
 * Entry point for the tier-1 text worker. This is the cheap half of text
 * extraction: native pdf.js reads and direct plain-text reads. It runs at high
 * concurrency because nothing here spawns a subprocess; a job either finishes in
 * milliseconds or parks the row at NEEDS_OCR and hands the slow work to
 * `ocr_queue`. Running it as its own process keeps a backlog of scanned PDFs
 * from holding up a library of born-digital ones.
 */

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const BUCKET = workerBucket();

// Env var takes precedence; falls back to the DB preference set via the web UI.
const LOW_MEMORY = process.env.LOW_MEMORY === "true" || process.env.LOW_MEMORY === "1"
  || await readLowMemoryPreference(prisma);

// Far above the OCR pool: these jobs are short and IO-bound, so read
// throughput limits them rather than CPU. Measure before trusting it on a NAS,
// where parallel reads can turn sequential access into seeking.
const TEXT_CONCURRENCY = parseEnvNumber("TEXT_CONCURRENCY", LOW_MEMORY ? 8 : 16);
const STALL_CHECK_INTERVAL_MS = parseEnvNumber("STALL_CHECK_INTERVAL_MS", 10 * 60 * 1000);

async function main () {
  const logger = createLogger("worker-text");
  const connection = buildRedisConnection(REDIS_URL);

  const publisher = new IORedis(REDIS_URL);
  publisher.on("error", err => logger.warn({ err }, "publisher redis error"));

  const publishJobUpdate = (update: { userId: string; mediaId: string; field: string; value: string }) => {
    publisher
      .publish(`media-events:${update.userId}`, JSON.stringify({ mediaId: update.mediaId, field: update.field, value: update.value }))
      .catch(err => logger.warn({ err }, "failed to publish job update"));
  };

  const mediaRepository = new MediaRepository(prisma);
  const documentRepository = new DocumentRepository(prisma);
  const preferencesService = new PreferencesService(new PreferencesRepository(prisma));
  const storage = createWorkerStorage();

  const textLogger = logger.child({ queue: TEXT_QUEUE, jobName: "text" });
  // A write-only handle on the expensive queue: tier 1 hands scans over, and
  // never runs one itself.
  const ocrQueue = new Queue<OcrJobData>(OCR_QUEUE, { connection });

  const textWorker = new Worker<OcrJobData>(
    TEXT_QUEUE,
    createOcrProcessor({
      mediaRepository,
      documentRepository,
      storage,
      bucket: BUCKET,
      allowedRoots: workerAllowedRoots(),
      enqueueOcr: async (data, opts) => enqueueOcrJob(ocrQueue, data, opts),
      getOcrMode: async userId =>
        userId ? (await preferencesService.getPreferences(userId)).ocrMode : DEFAULT_PREFERENCES.ocrMode,
      getOcrTimeoutCapMinutes: async userId =>
        userId ? (await preferencesService.getPreferences(userId)).ocrTimeoutCapMinutes : DEFAULT_PREFERENCES.ocrTimeoutCapMinutes,
      logger: textLogger,
      queueName: TEXT_QUEUE,
      publishJobUpdate,
    }),
    { connection, concurrency: TEXT_CONCURRENCY },
  );

  if (LOW_MEMORY) logger.info("low-memory mode: text concurrency halved");

  textWorker.on("ready", () =>
    textLogger.info({ queue: TEXT_QUEUE, concurrency: TEXT_CONCURRENCY }, "text worker ready"),
  );

  // Stall detection watches text state, so it belongs to whichever text-side
  // process is up. ocr.ts runs it too: the sweep can be repeated safely, and
  // either container alone still has to catch a stalled row.
  const stallLogger = logger.child({ component: "stall-detection" });
  const runStallCheck = () =>
    markStalledJobs(mediaRepository, stallLogger).catch(err =>
      stallLogger.error({ err }, "stall detection failed"),
    );
  void runStallCheck();
  const stallInterval = setInterval(runStallCheck, STALL_CHECK_INTERVAL_MS);

  textWorker.on("failed", async (job, err) => {
    const errorCode =
      err instanceof TextJobError
        ? err.code
        : err instanceof Error && err.name
          ? err.name
          : "UNKNOWN_ERROR";
    const attempts = job?.opts?.attempts ?? 1;
    const isFinal = job ? (job.attemptsMade ?? 0) >= attempts : true;

    if (job?.data?.mediaId && isFinal) {
      try {
        await mediaRepository.setTextState(job.data.mediaId, "ERROR");
        if (job.data.userId) {
          publishJobUpdate({ userId: job.data.userId, mediaId: job.data.mediaId, field: "textState", value: "ERROR" });
        }
      } catch (updateErr) {
        textLogger.error(
          {
            jobName: "text",
            queue: TEXT_QUEUE,
            jobId: job?.id ?? "unknown",
            mediaId: job.data.mediaId,
            userId: job.data.userId ?? null,
            errorCode: "TEXT_STATE_UPDATE_FAILED",
            err: updateErr,
          },
          "failed to mark textState ERROR",
        );
      }
    }

    textLogger.error(
      {
        jobName: "text",
        queue: TEXT_QUEUE,
        jobId: job?.id ?? "unknown",
        mediaId: job?.data?.mediaId ?? "unknown",
        userId: job?.data?.userId ?? null,
        attempt: job?.attemptsMade ?? 0,
        durationMs: job?.processedOn ? Date.now() - job.processedOn : undefined,
        errorCode,
        err,
      },
      "text job failed",
    );
  });

  textWorker.on("error", err =>
    textLogger.error(
      {
        jobName: "text",
        queue: TEXT_QUEUE,
        errorCode: err instanceof Error && err.name ? err.name : "WORKER_ERROR",
        err,
      },
      "worker error",
    ),
  );

  logger.info({ queue: TEXT_QUEUE, concurrency: TEXT_CONCURRENCY }, "text worker started");

  const shutdown = async () => {
    logger.info("text worker shutting down...");
    clearInterval(stallInterval);
    await textWorker.close();
    await ocrQueue.close();
    await publisher.quit();
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch(err => {
  const logger = createLogger("worker-text");
  logger.error({ err }, "text worker fatal");
  process.exit(1);
});

function parseEnvNumber (name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}
