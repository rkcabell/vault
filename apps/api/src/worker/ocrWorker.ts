//File: apps/api/src/worker/ocrWorker.ts
import "dotenv/config";
import { setTimeout as delay } from "node:timers/promises";
import { HeadObjectCommand } from "@aws-sdk/client-s3";
import { Queue, Worker, type ConnectionOptions, type JobsOptions, type Job } from "bullmq";
import { s3 } from "../plugins/s3Client.js";
import { prisma } from "../plugins/prismaClient.js";
import { processTextJob } from "../lib/text/processTextJob.js";

type OcrJobData = {
  mediaId: string;
  storageKey?: string;
  forceOcr?: boolean;
  language?: string;
  rotation?: string;
  userId?: string;
  title?: string;
};

type OcrQueue = {
  add: (name: string, data: OcrJobData, opts?: JobsOptions) => Promise<Job<OcrJobData>>;
  close: () => Promise<void>;
};

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const OCR_QUEUE = process.env.OCR_QUEUE ?? "ocr_queue";
const BUCKET = process.env.S3_BUCKET as string | undefined;
if (!BUCKET) {
  throw new Error("S3_BUCKET env var is required for ocr worker");
}

const isTest = process.env.NODE_ENV === "test";
const sleep = isTest ? async () => {} : delay;

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

const connection = buildRedisConnection(REDIS_URL);

// Don’t instantiate a real BullMQ queue in tests
const queue: OcrQueue = isTest
  ? {
      add: async () => undefined as unknown as Job<OcrJobData>,
      close: async () => undefined,
    }
  : new Queue<OcrJobData>(OCR_QUEUE, { connection });

const MAX_SOURCE_POLL_TRIES = 8;

async function waitUntilSourceExists (bucket: string, key: string): Promise<boolean> {
  for (let i = 0; i < MAX_SOURCE_POLL_TRIES; i += 1) {
    try {
      await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return true;
    } catch {
      await sleep(1000 * (i + 1));
    }
  }
  return false;
}

function isTransientError (message: string) {
  return (
    message.includes("SOURCE_NOT_READY") ||
    message.includes("NetworkingError") ||
    message.includes("Timeout") ||
    message.includes("Throttling")
  );
}

export async function handleJob (data: OcrJobData) {
  const { mediaId, storageKey, forceOcr } = data;

  console.log(`[worker] ocr job start mediaId=${mediaId} forceOcr=${Boolean(forceOcr)}`);

  const media = await prisma.media.findUnique({
    where: { id: mediaId },
    select: { id: true, storageKey: true, mimeType: true },
  });

  if (!media) {
    console.warn(`[worker] media not found: ${mediaId}`);
    return;
  }

  const key = storageKey ?? media.storageKey;
  console.log(`[worker] media loaded mediaId=${mediaId} mimeType=${media.mimeType} key=${key}`);

  const exists = await waitUntilSourceExists(BUCKET!, key);
  if (!exists) {
    console.warn(`[worker] source not ready mediaId=${mediaId} key=${key}`);
    throw new Error("SOURCE_NOT_READY");
  }

  if (media.mimeType?.startsWith("application/pdf") && !forceOcr) {
    try {
      console.log(`[worker] pdf extraction start mediaId=${mediaId}`);
      const extracted = await processTextJob({
        s3,
        bucket: BUCKET!,
        key,
        mimeType: media.mimeType,
      });
      console.log(
        `[worker] pdf extraction done mediaId=${mediaId} chars=${extracted.rawText.length} needsOcr=${extracted.needsOcr}`,
      );

      await prisma.document.upsert({
        where: { mediaId },
        update: {
          rawText: extracted.rawText,
          pages: extracted.pages ?? [],
          textSource: extracted.textSource,
        },
        create: {
          mediaId,
          rawText: extracted.rawText,
          pages: extracted.pages ?? [],
          textSource: extracted.textSource,
        },
      });

      await prisma.media.update({
        where: { id: mediaId },
        data: { textState: extracted.needsOcr ? "PENDING" : "READY" },
      });

      if (extracted.needsOcr) {
        await queue.add(
          "ocr",
          { mediaId, storageKey: key, forceOcr: true },
          { attempts: 5, backoff: { type: "exponential", delay: 2000 } },
        );
        console.log(`[worker] queued OCR fallback mediaId=${mediaId}`);
      }

      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("SOURCE_NOT_READY")) {
        console.warn(`[worker] pdf source not ready mediaId=${mediaId} key=${key}`);
        throw err;
      }
      console.warn(`[worker] pdf text extraction failed mediaId=${mediaId} error=${msg}`);
    }
  }

  console.log(`[worker] OCR fallback mediaId=${mediaId}`);
  await sleep(1000);

  const ocrResult = await processTextJob({
    s3,
    bucket: BUCKET!,
    key,
    mimeType: media.mimeType,
    forceOcr: true,
  });

  await prisma.document.upsert({
    where: { mediaId },
    update: {
      rawText: ocrResult.rawText,
      pages: ocrResult.pages ?? [],
      textSource: ocrResult.textSource,
    },
    create: {
      mediaId,
      rawText: ocrResult.rawText,
      pages: ocrResult.pages ?? [],
      textSource: ocrResult.textSource,
    },
  });

  await prisma.media.update({
    where: { id: mediaId },
    data: { textState: "READY" },
  });

  console.log(`[worker] processed OCR media ${mediaId}`);
}

if (!isTest) {
  const worker = new Worker<OcrJobData>(
    OCR_QUEUE,
    async job => {
      await handleJob(job.data);
    },
    { connection, concurrency: 1 },
  );

  worker.on("completed", job => {
    console.log(`[worker] job completed id=${job.id} mediaId=${job.data.mediaId}`);
  });

  worker.on("failed", async (job, err) => {
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
      `[worker] job failed id=${job?.id ?? "unknown"} mediaId=${
        job?.data?.mediaId ?? "unknown"
      } error=${msg}`,
    );
  });

  worker.on("error", err => {
    console.error("[worker] worker error", err);
  });

  console.log(`[worker] listening on ${OCR_QUEUE}`);

  const shutdown = async () => {
    await worker.close();
    await queue.close();
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}
