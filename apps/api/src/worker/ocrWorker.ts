// File: apps/api/src/worker/ocrWorker.ts
import { setTimeout as delay } from "node:timers/promises";
import { HeadObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import type { JobsOptions } from "bullmq";

import type { PrismaClient } from "@prisma/client";
import { processTextJob } from "../lib/text/processTextJob.js";

export type OcrJobData = {
  mediaId: string;
  storageKey?: string;
  forceOcr?: boolean;
  language?: string;
  rotation?: string;
  userId?: string;
  title?: string;
};

const MAX_SOURCE_POLL_TRIES = 8;
console.log("NODE_ENV =", process.env.NODE_ENV);

// Decide sleep timer at call time to avoid delays in tests
function sleep (ms: number) {
  return process.env.NODE_ENV === "test" ? Promise.resolve() : delay(ms);
}

function isTransientError (message: string) {
  return (
    message.includes("SOURCE_NOT_READY") ||
    message.includes("NetworkingError") ||
    message.includes("Timeout") ||
    message.includes("Throttling")
  );
}

async function waitUntilSourceExists (s3: S3Client, bucket: string, key: string): Promise<boolean> {
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

export type OcrDeps = {
  prisma: PrismaClient;
  s3: S3Client;
  bucket: string;
  enqueueOcr: (data: OcrJobData, opts?: JobsOptions) => Promise<unknown>;
};

export async function processOcrJob (deps: OcrDeps, data: OcrJobData) {
  const { prisma, s3, bucket, enqueueOcr } = deps;
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

  const exists = await waitUntilSourceExists(s3, bucket, key);
  if (!exists) {
    console.warn(`[worker] source not ready mediaId=${mediaId} key=${key}`);
    throw new Error("SOURCE_NOT_READY");
  }

  // Try native PDF extraction first (unless forced OCR)
  if (media.mimeType?.startsWith("application/pdf") && !forceOcr) {
    try {
      console.log(`[worker] pdf extraction start mediaId=${mediaId}`);
      const extracted = await processTextJob({
        s3,
        bucket,
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
        await enqueueOcr(
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
      // fall through to OCR
    }
  }

  // OCR fallback
  console.log(`[worker] OCR fallback mediaId=${mediaId}`);
  await sleep(1000);

  const ocrResult = await processTextJob({
    s3,
    bucket,
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

export function createOcrProcessor (deps: OcrDeps) {
  // BullMQ processor signature: (job) => Promise<void>
  return async (job: {
    data: OcrJobData;
    id?: string;
    opts?: { attempts?: number };
    attemptsMade?: number;
  }) => {
    try {
      await processOcrJob(deps, job.data);
    } catch (err) {
      // keep error semantics the same as before: throw to let BullMQ retry
      const msg = err instanceof Error ? err.message : String(err);

      // only mark ERROR when non-transient and final attempt happens is handled in index.ts now
      console.error(
        `[worker] job error id=${job.id ?? "unknown"} mediaId=${job.data.mediaId} error=${msg}`,
      );

      throw err;
    }
  };
}

export { isTransientError };
