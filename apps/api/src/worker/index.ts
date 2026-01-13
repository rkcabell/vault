// File: apps/api/src/worker/index.ts
import "dotenv/config";

import IORedis from "ioredis";
import { Queue, Worker, type ConnectionOptions } from "bullmq";

import { s3 } from "../plugins/s3Client.js";
import { prisma } from "@vault/db";

import { createOcrProcessor, type OcrJobData } from "./ocrWorker.js";
import { createThumbProcessor, sanitizeThumbError, type ThumbJob } from "./thumbWorker.js";

function buildRedisConnection (url: string): ConnectionOptions {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 6379,
    username: parsed.username || undefined,
    password: parsed.password || undefined,
    db: parsed.pathname ? Number(parsed.pathname.replace("/", "")) || 0 : 0,
    tls: parsed.protocol === "rediss:" ? {} : undefined,
  };
}

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const BUCKET = requiredEnv("S3_BUCKET");

const OCR_QUEUE = process.env.OCR_QUEUE ?? "ocr_queue";
const THUMB_QUEUE = process.env.THUMB_QUEUE ?? "thumb_queue";

function isTransientError (message: string) {
  return (
    message.includes("SOURCE_NOT_READY") ||
    message.includes("NetworkingError") ||
    message.includes("Timeout") ||
    message.includes("Throttling")
  );
}

async function main () {
  const connection = buildRedisConnection(REDIS_URL);
  // BullMQ can accept either ConnectionOptions or an ioredis instance.
  // We’ll use ConnectionOptions for Workers and Queue.
  const ioredis = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });

  // Queue client used by OCR worker to enqueue fallback OCR jobs.
  const ocrQueue = new Queue<OcrJobData>(OCR_QUEUE, { connection });

  const ocrWorker = new Worker<OcrJobData>(
    OCR_QUEUE,
    createOcrProcessor({
      prisma,
      s3,
      bucket: BUCKET,
      enqueueOcr: async (data, opts) => ocrQueue.add("ocr", data, opts),
    }),
    { connection, concurrency: 1 },
  );

  const thumbWorker = new Worker<ThumbJob>(
    THUMB_QUEUE,
    createThumbProcessor({ prisma, s3, bucket: BUCKET }),
    { connection, concurrency: 1 },
  );

  ocrWorker.on("ready", () => console.log(`[worker] OCR ready queue=${OCR_QUEUE}`));
  thumbWorker.on("ready", () => console.log(`[worker] THUMB ready queue=${THUMB_QUEUE}`));

  ocrWorker.on("completed", job =>
    console.log(`[worker] OCR completed id=${job.id} mediaId=${job.data.mediaId}`),
  );
  thumbWorker.on("completed", job =>
    console.log(`[worker] THUMB completed id=${job.id} mediaId=${job.data.mediaId}`),
  );

  ocrWorker.on("failed", async (job, err) => {
    const msg = err instanceof Error ? err.message : String(err);
    const attempts = job?.opts.attempts ?? 1;
    const isFinal = job ? job.attemptsMade >= attempts : true;
    const transient = isTransientError(msg);

    if (job?.data?.mediaId && isFinal && !transient) {
      try {
        await prisma.media.update({
          where: { id: job.data.mediaId },
          data: { textState: "ERROR" },
        });
      } catch (updateErr) {
        console.error("[worker] failed to mark textState ERROR", updateErr);
      }
    }

    console.error(
      `[worker] OCR failed id=${job?.id ?? "unknown"} mediaId=${
        job?.data?.mediaId ?? "unknown"
      } error=${msg}`,
    );
  });

  thumbWorker.on("failed", async (job, err) => {
    const msg = err instanceof Error ? err.message : String(err);
    const attempts = job?.opts.attempts ?? 1;
    const isFinal = job ? job.attemptsMade >= attempts : true;
    const reason = sanitizeThumbError(err);

    if (job?.data?.mediaId && isFinal) {
      try {
        await prisma.media.update({
          where: { id: job.data.mediaId },
          data: { thumbState: "FAILED", thumbError: reason },
          select: { id: true, thumbState: true, thumbnailKey: true },
        });
      } catch (updateErr) {
        console.error("[worker] failed to mark thumbState FAILED", updateErr);
      }
    }

    console.error(
      `[worker] THUMB failed id=${job?.id ?? "unknown"} mediaId=${
        job?.data?.mediaId ?? "unknown"
      } error=${msg}`,
    );
  });

  ocrWorker.on("error", err => console.error("[worker] OCR worker error", err));
  thumbWorker.on("error", err => console.error("[worker] THUMB worker error", err));

  console.log("[worker] started");

  const shutdown = async () => {
    console.log("[worker] shutting down...");
    await Promise.all([ocrWorker.close(), thumbWorker.close()]);
    await ocrQueue.close();
    await ioredis.quit();
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch(err => {
  console.error("[worker] fatal:", err);
  process.exit(1);
});

function requiredEnv (name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} env var is required`);
  return v;
}
