// apps/api/src/worker/thumbWorker.ts
import { setTimeout as delay } from "node:timers/promises";
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import sharp from "sharp";

// Use your shared plugin clients instead of re-creating singletons here
import { s3 } from "../plugins/s3Client.js";
import { prisma } from "../plugins/prismaClient.js";

// Worker still needs its own Redis connection for BRPOP
import Redis from "ioredis";

/**
 * Job shape (matches enqueueThumbnails.ts)
 * Example payload (from your smoke test):
 * {
 *   "type": "thumb",
 *   "mediaId": "1111-...-1111",
 *   "userId": "2222-...-2222",
 *   "storageKey": "originals/demo.jpg",
 *   "outKey": "thumbs/1111-...-1111.webp",
 *   "size": 512,
 *   "attempt": 0
 * }
 */
export interface ThumbJob {
  type: "thumb";
  mediaId: string;
  userId: string;
  storageKey: string;
  outKey?: string;
  size?: number; // defaults to 512
  attempt?: number; // number of attempts so far
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
    (v["size"] === undefined || (typeof v["size"] === "number" && Number.isFinite(v["size"]))) &&
    (v["attempt"] === undefined ||
      (typeof v["attempt"] === "number" && Number.isFinite(v["attempt"])))
  );
}

const BUCKET = process.env.S3_BUCKET as string | undefined;
if (!BUCKET) {
  // Fail fast at startup if misconfigured
  throw new Error("S3_BUCKET env var is required for thumb worker");
}

// Utility: stream → Buffer
async function streamToBuffer (stream: ReadableStream | NodeJS.ReadableStream): Promise<Buffer> {
  if ("getReader" in (stream as ReadableStream)) {
    // Web streams
    const reader = (stream as ReadableStream).getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value as Uint8Array);
    }
    return Buffer.concat(chunks);
  } else {
    // Node streams
    const nodeStream = stream as NodeJS.ReadableStream;
    const chunks: Buffer[] = [];
    return new Promise<Buffer>((resolve, reject) => {
      nodeStream.on("data", (c: Buffer) => chunks.push(c));
      nodeStream.on("end", () => resolve(Buffer.concat(chunks)));
      nodeStream.on("error", reject);
    });
  }
}

async function getObjectToBuffer (bucket: string, key: string): Promise<Buffer | null> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = res.Body;
    if (!body) return null;
    return streamToBuffer(body as NodeJS.ReadableStream);
  } catch {
    // Not found or not yet present
    return null;
  }
}

/**
 * Optional lightweight source-exists poller using HeadObject.
 * Useful to avoid immediate requeue churn while upload is racing.
 */
async function waitUntilSourceExists (bucket: string, key: string): Promise<boolean> {
  const maxTries = 8;
  for (let i = 0; i < maxTries; i++) {
    try {
      await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return true;
    } catch {
      // exponential backoff: 1s, 2s, 3s, ... up to 8s
      await delay(1000 * (i + 1));
    }
  }
  return false;
}

function nextBackoffMs (attempt: number): number {
  // 1s * 2^attempt, capped at 30s
  const base = 1000 * Math.pow(2, Math.max(0, attempt));
  return Math.min(base, 30_000);
}

/**
 * Core processor (pure function over a job).
 * - Derives outKey if missing
 * - Idempotency: skip if DB already points to the same outKey
 * - Polls for source, then fetches and transforms via sharp → webp
 * - Uploads with long-lived cache headers
 * - Updates DB: thumbnailKey (and status: READY)
 */
export async function processThumb (job: ThumbJob): Promise<void> {
  const size = Math.max(16, Math.min(4096, job.size ?? 512));
  const outKey = job.outKey ?? `thumbs/${job.mediaId}.webp`;
  const storageKey = job.storageKey;

  // Idempotency: if DB already has the same key, skip work
  const existing = await prisma.media.findUnique({
    where: { id: job.mediaId },
    select: { thumbnailKey: true },
  });

  if (existing?.thumbnailKey === outKey) {
    // Already produced this exact thumbnail
    return;
  }

  // Optionally short-poll the source to reduce requeues during fresh uploads
  const exists = await waitUntilSourceExists(BUCKET!, storageKey);
  if (!exists) {
    // If still not there, fail so the caller (loop) requeues with backoff
    throw new Error("SOURCE_NOT_READY");
  }

  // Fetch original into memory
  const original = await getObjectToBuffer(BUCKET!, storageKey);
  if (!original) {
    // Let caller handle backoff / requeue
    throw new Error("SOURCE_NOT_READY");
  }

  // Produce WebP thumbnail (auto-rotate, cover-fit within size x size)
  const webp = await sharp(original, { failOn: "none" })
    .rotate()
    .resize(size, size, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer();

  // Upload thumbnail
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET!,
      Key: outKey,
      Body: webp,
      ContentType: "image/webp",
      // Immutable cache (1 year) for client-side & CDN friendliness
      CacheControl: "public, max-age=31536000, immutable",
    }),
  );

  // Update DB (thumbnailKey; and mark READY if your schema uses this)
  await prisma.media.update({
    where: { id: job.mediaId },
    data: { thumbnailKey: outKey, status: "READY" },
  });
}

/**
 * Worker loop:
 * - BRPOP thumb:queue
 * - Parse & validate
 * - Process
 * - On SOURCE_NOT_READY or transient failure → LPUSH back with attempt+1 and exponential backoff
 */
async function main (): Promise<void> {
  const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
  const queueName = process.env.THUMB_QUEUE ?? "thumb:queue";
  const redis = new Redis(redisUrl);

  console.log("[thumbWorker] listening on", queueName, "…");

  for (;;) {
    const res = await redis.brpop(queueName, 0); // blocks until a job is available
    if (!res) continue;

    const [, payload] = res; // [queue, jsonString]
    let job: ThumbJob | null = null;

    try {
      const parsed = JSON.parse(payload) as unknown;
      if (!isThumbJob(parsed)) {
        console.warn("[thumbWorker] ignored job (wrong shape):", payload);
        continue;
      }
      job = parsed;
    } catch (e) {
      console.error("[thumbWorker] invalid JSON payload:", payload, e);
      continue;
    }

    const attempt = Math.max(0, job.attempt ?? 0);

    try {
      await processThumb(job);
      console.log(
        `[thumbWorker] ✅ processed mediaId=${job.mediaId} outKey=${
          job.outKey ?? `thumbs/${job.mediaId}.webp`
        }`,
      );
    } catch (err) {
      const msg =
        isRecord(err) && typeof err["message"] === "string"
          ? (err["message"] as string)
          : String(err);
      const transient =
        msg.includes("SOURCE_NOT_READY") ||
        msg.includes("NetworkingError") ||
        msg.includes("Timeout") ||
        msg.includes("Throttling");

      if (transient) {
        const nextAttempt = attempt + 1;
        const backoffMs = nextBackoffMs(attempt);

        // Requeue with incremented attempt
        const requeuePayload: ThumbJob = {
          ...job,
          attempt: nextAttempt,
        };

        // Sleep locally before requeue to avoid immediate hotlooping
        await delay(backoffMs);

        await redis.lpush(queueName, JSON.stringify(requeuePayload));
        console.warn(
          `[thumbWorker] ⏳ requeued mediaId=${job.mediaId} attempt=${nextAttempt} backoff=${backoffMs}ms reason=${msg}`,
        );
      } else {
        console.error("[thumbWorker] fatal error for job:", job, err);
      }
    }
  }
}

main().catch(e => {
  console.error("[thumbWorker] crashed:", e);
  process.exitCode = 1;
});
