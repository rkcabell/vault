// File: apps/api/src/worker/thumbWorker.ts
import { setTimeout as delay } from "node:timers/promises";
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import sharp from "sharp";
import type { PrismaClient } from "@prisma/client";

export interface ThumbJob {
  type: "thumb";
  mediaId: string;
  userId: string;
  storageKey: string;
  outKey?: string;
  size?: number; // defaults to 512
}

function isRecord (v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isThumbJob (v: unknown): v is ThumbJob {
  if (!isRecord(v)) return false;
  return (
    v["type"] === "thumb" &&
    typeof v["mediaId"] === "string" &&
    typeof v["userId"] === "string" &&
    typeof v["storageKey"] === "string" &&
    (v["outKey"] === undefined || typeof v["outKey"] === "string") &&
    (v["size"] === undefined || (typeof v["size"] === "number" && Number.isFinite(v["size"])))
  );
}

const THUMB_ERROR_FALLBACK = "thumbnail_failed";
const MAX_THUMB_ERROR_LENGTH = 160;

export function sanitizeThumbError (err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const cleaned = raw.replace(/\s+/g, " ").trim();
  if (!cleaned) return THUMB_ERROR_FALLBACK;
  return cleaned.length > MAX_THUMB_ERROR_LENGTH
    ? cleaned.slice(0, MAX_THUMB_ERROR_LENGTH)
    : cleaned;
}

async function streamToBuffer (stream: ReadableStream | NodeJS.ReadableStream): Promise<Buffer> {
  if ("getReader" in (stream as ReadableStream)) {
    const reader = (stream as ReadableStream).getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value as Uint8Array);
    }
    return Buffer.concat(chunks);
  } else {
    const nodeStream = stream as NodeJS.ReadableStream;
    const chunks: Buffer[] = [];
    return new Promise<Buffer>((resolve, reject) => {
      nodeStream.on("data", (c: Buffer) => chunks.push(c));
      nodeStream.on("end", () => resolve(Buffer.concat(chunks)));
      nodeStream.on("error", reject);
    });
  }
}

async function getObjectToBuffer (
  s3: S3Client,
  bucket: string,
  key: string,
): Promise<Buffer | null> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = res.Body;
    if (!body) return null;
    return streamToBuffer(body as NodeJS.ReadableStream);
  } catch {
    return null;
  }
}

async function waitUntilSourceExists (s3: S3Client, bucket: string, key: string): Promise<boolean> {
  const maxTries = 4;
  for (let i = 0; i < maxTries; i++) {
    try {
      await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return true;
    } catch {
      await delay(1000 * (i + 1));
    }
  }
  return false;
}

export type ThumbDeps = {
  prisma: PrismaClient;
  s3: S3Client;
  bucket: string;
};

export async function processThumb (deps: ThumbDeps, job: ThumbJob): Promise<void> {
  const { prisma, s3, bucket } = deps;

  const size = Math.max(16, Math.min(4096, job.size ?? 512));
  const outKey = job.outKey ?? `thumbs/${job.mediaId}.webp`;
  const storageKey = job.storageKey;

  const existing = await prisma.media.findUnique({
    where: { id: job.mediaId },
    select: { thumbnailKey: true, thumbState: true },
  });

  if (existing?.thumbnailKey === outKey) {
    if (existing.thumbState !== "READY") {
      await prisma.media.update({
        where: { id: job.mediaId },
        data: { thumbState: "READY", thumbError: null },
        select: { id: true, thumbState: true, thumbnailKey: true },
      });
    }
    return;
  }

  const exists = await waitUntilSourceExists(s3, bucket, storageKey);
  if (!exists) throw new Error("SOURCE_NOT_READY");

  const original = await getObjectToBuffer(s3, bucket, storageKey);
  if (!original) throw new Error("SOURCE_NOT_READY");

  let webp: Buffer;
  try {
    webp = await sharp(original, { failOn: "none" })
      .rotate()
      .resize(size, size, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer();
  } catch (err) {
    const reason = sanitizeThumbError(err);
    await prisma.media.update({
      where: { id: job.mediaId },
      data: { thumbState: "FAILED", thumbError: reason },
      select: { id: true, thumbState: true, thumbnailKey: true },
    });
    console.warn(
      `[thumbWorker] failed to render thumbnail mediaId=${job.mediaId} reason=${reason}`,
    );
    return;
  }

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: outKey,
      Body: webp,
      ContentType: "image/webp",
      CacheControl: "public, max-age=31536000, immutable",
    }),
  );

  await prisma.media.update({
    where: { id: job.mediaId },
    data: { thumbnailKey: outKey, thumbState: "READY", thumbError: null },
    select: { id: true, thumbState: true, thumbnailKey: true },
  });
}

export function createThumbProcessor (deps: ThumbDeps) {
  return async (job: { data: unknown; id?: string; attemptsMade?: number }) => {
    const payload = job.data;

    if (!isThumbJob(payload)) {
      console.warn("[thumbWorker] ignored job (wrong shape):", payload);
      return;
    }

    try {
      await processThumb(deps, payload);
      console.log(
        `[thumbWorker] processed mediaId=${payload.mediaId} outKey=${
          payload.outKey ?? `thumbs/${payload.mediaId}.webp`
        }`,
      );
    } catch (err) {
      const msg =
        isRecord(err) && typeof err["message"] === "string"
          ? (err["message"] as string)
          : String(err);

      console.warn(
        `[thumbWorker] job failed mediaId=${payload.mediaId} attempt=${
          job.attemptsMade ?? 0
        } error=${msg}`,
      );
      throw err;
    }
  };
}
