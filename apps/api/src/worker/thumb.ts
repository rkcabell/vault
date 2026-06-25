// Entry point for the thumbnail worker process.
// Run independently of the OCR worker so a thumbnail failure cannot
// block OCR processing (and vice-versa).
import "dotenv/config";

import { Worker } from "bullmq";
import IORedis from "ioredis";

import { prisma } from "@vault/db";
import { createWorkerStorage, workerBucket, workerAllowedRoots } from "./storageFromEnv.js";
import { readLowMemoryPreference } from "./workerPrefs.js";
import { createThumbProcessor, sanitizeThumbError, type ThumbJob } from "./thumbWorker.js";
import { MediaRepository } from "../repositories/mediaRepository.js";
import { MediaMetadataRepository } from "../repositories/mediaMetadataRepository.js";
import { buildRedisConnection } from "../lib/config/redis.js";
import { createLogger } from "../lib/logger.js";

const REDIS_URL       = process.env.REDIS_URL ?? "redis://localhost:6379";
const BUCKET          = workerBucket();

// Env var takes precedence; falls back to the DB preference set via the web UI.
const LOW_MEMORY = process.env.LOW_MEMORY === "true" || process.env.LOW_MEMORY === "1"
  || await readLowMemoryPreference(prisma);

const THUMB_QUEUE       = process.env.THUMB_QUEUE ?? "thumb_queue";
const THUMB_CONCURRENCY = parseEnvNumber("THUMB_CONCURRENCY", LOW_MEMORY ? 4 : 8);

async function main() {
  const logger     = createLogger("worker-thumb");
  const connection = buildRedisConnection(REDIS_URL);

  const publisher = new IORedis(REDIS_URL);
  publisher.on("error", err => logger.warn({ err }, "publisher redis error"));

  const publishJobUpdate = (update: { userId: string; mediaId: string; field: string; value: string }) => {
    publisher
      .publish(`media-events:${update.userId}`, JSON.stringify({ mediaId: update.mediaId, field: update.field, value: update.value }))
      .catch(err => logger.warn({ err }, "failed to publish job update"));
  };

  const mediaRepository    = new MediaRepository(prisma);
  const metadataRepository = new MediaMetadataRepository(prisma);
  const storage            = createWorkerStorage();

  const thumbLogger = logger.child({ queue: THUMB_QUEUE, jobName: "thumb" });

  const thumbWorker = new Worker<ThumbJob>(
    THUMB_QUEUE,
    createThumbProcessor({
      prismaMedia: mediaRepository,
      metadataRepository,
      storage,
      bucket: BUCKET,
      allowedRoots: workerAllowedRoots(),
      logger: thumbLogger,
      queueName: THUMB_QUEUE,
      publishJobUpdate,
    }),
    { connection, concurrency: THUMB_CONCURRENCY },
  );

  if (LOW_MEMORY) logger.info("low-memory mode: thumb concurrency capped at 4");

  thumbWorker.on("ready", () =>
    thumbLogger.info({ queue: THUMB_QUEUE, concurrency: THUMB_CONCURRENCY }, "thumb worker ready"),
  );

  thumbWorker.on("failed", async (job, err) => {
    const msg     = err instanceof Error ? err.message : String(err);
    const attempts = job?.opts?.attempts ?? 1;
    const isFinal  = job ? (job.attemptsMade ?? 0) >= attempts : true;
    const reason   = sanitizeThumbError(err);

    if (job?.data?.mediaId && isFinal) {
      try {
        await mediaRepository.setThumbFailed(job.data.mediaId, reason);
        publishJobUpdate({ userId: job.data.userId, mediaId: job.data.mediaId, field: "thumbState", value: "FAILED" });
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

  logger.info({ queue: THUMB_QUEUE, concurrency: THUMB_CONCURRENCY }, "thumb worker started");

  const shutdown = async () => {
    logger.info("thumb worker shutting down...");
    await thumbWorker.close();
    await publisher.quit();
  };

  process.on("SIGINT",  () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch(err => {
  const logger = createLogger("worker-thumb");
  logger.error({ err }, "thumb worker fatal");
  process.exit(1);
});

function parseEnvNumber(name: string, fallback: number): number {
  const raw    = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}
