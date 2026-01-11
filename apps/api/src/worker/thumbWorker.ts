// apps/api/src/worker/thumbWorker.ts
import { setTimeout as delay } from "node:timers/promises";
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import sharp from "sharp";
import { Worker, type ConnectionOptions } from "bullmq";

// Use your shared plugin clients instead of re-creating singletons here
import { s3 } from "../plugins/s3Client.js";
import { prisma } from "../plugins/prismaClient.js";

/**
 * Job shape (matches enqueueThumbnails.ts)
 * Example payload (from your smoke test):
 * {
 *   "type": "thumb",
 *   "mediaId": "1111-...-1111",
 *   "userId": "2222-...-2222",
 *   "storageKey": "originals/demo.jpg",
 *   "outKey": "thumbs/1111-...-1111.webp",
 *   "size": 512
 * }
 */
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

const BUCKET = process.env.S3_BUCKET as string | undefined;
if (!BUCKET) {
  // Fail fast at startup if misconfigured
  throw new Error("S3_BUCKET env var is required for thumb worker");
}

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const THUMB_QUEUE = process.env.THUMB_QUEUE ?? "thumb:queue";

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
  const maxTries = 4;
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

/**
 * Core processor (pure function over a job).
 * - Derives outKey if missing
 * - Idempotency: skip if DB already points to the same outKey
 * - Polls for source, then fetches and transforms via sharp → webp
 * - Uploads with long-lived cache headers
 * - Updates DB: thumbnailKey (and thumbState: READY)
 */
export async function processThumb (job: ThumbJob): Promise<void> {
  const size = Math.max(16, Math.min(4096, job.size ?? 512));
  const outKey = job.outKey ?? `thumbs/${job.mediaId}.webp`;
  const storageKey = job.storageKey;

  // Idempotency: if DB already has the same key, skip work
  const existing = await prisma.media.findUnique({
    where: { id: job.mediaId },
    select: { thumbnailKey: true, thumbState: true },
  });

  if (existing?.thumbnailKey === outKey) {
    // Already produced this exact thumbnail
    if (existing.thumbState !== "READY") {
      await prisma.media.update({
        where: { id: job.mediaId },
        data: { thumbState: "READY" },
      });
    }
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
    data: { thumbnailKey: outKey, thumbState: "READY" },
  });
}

// BullMQ worker: processes thumb jobs with retry/backoff handled by queue options.
function isTransientError (message: string) {
  return (
    message.includes("SOURCE_NOT_READY") ||
    message.includes("NetworkingError") ||
    message.includes("Timeout") ||
    message.includes("Throttling")
  );
}

if (process.env.NODE_ENV !== "test") {
  const worker = new Worker<ThumbJob>(
    THUMB_QUEUE,
    async (job) => {
      const payload = job.data;
      if (!isThumbJob(payload)) {
        console.warn("[thumbWorker] ignored job (wrong shape):", payload);
        return;
      }

      try {
        await processThumb(payload);
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
          `[thumbWorker] job failed mediaId=${payload.mediaId} attempt=${job.attemptsMade} error=${msg}`,
        );
        throw err;
      }
    },
    { connection, concurrency: 1 },
  );

  worker.on("completed", (job) => {
    console.log(
      `[thumbWorker] job completed id=${job.id} mediaId=${job.data.mediaId}`,
    );
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
          data: { thumbState: "ERROR" },
        });
      } catch (updateErr) {
        console.error("[thumbWorker] failed to mark thumbState ERROR", updateErr);
      }
    }

    console.error(
      `[thumbWorker] job failed id=${job?.id ?? "unknown"} mediaId=${job?.data?.mediaId ?? "unknown"} error=${msg}`,
    );
  });

  worker.on("error", (err) => {
    console.error("[thumbWorker] worker error", err);
  });

  console.log(`[thumbWorker] listening on ${THUMB_QUEUE}`);

  const shutdown = async () => {
    await worker.close();
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}
