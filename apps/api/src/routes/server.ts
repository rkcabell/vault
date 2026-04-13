import type { FastifyPluginAsync } from "fastify";
import { Queue } from "bullmq";
import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { requireAuth } from "../utils/authGuard.js";
import { buildRedisConnection } from "../lib/config/redis.js";

export const serverRoutes: FastifyPluginAsync = async (app) => {
  app.get("/status", { preHandler: [requireAuth] }, async () => {
    const mem = process.memoryUsage();
    const publicUrl = new URL(app.config.S3_PUBLIC_ENDPOINT);
    publicUrl.port = "9001";
    const minioConsoleUrl = `${publicUrl.origin}/browser/${app.config.S3_BUCKET}`;
    return {
      env:           app.config.NODE_ENV,
      apiPort:       app.config.PORT,
      corsOrigin:    app.config.CORS_ORIGIN,
      uptimeSeconds: process.uptime(),
      memoryMB:      Math.round(mem.rss / 1024 / 1024),
      minioConsoleUrl,
    };
  });

  app.get("/storage", { preHandler: [requireAuth] }, async () => {
    let sizeBytes = 0;
    let objectCount = 0;
    let continuationToken: string | undefined;
    do {
      const res = await app.s3.send(new ListObjectsV2Command({
        Bucket: app.config.S3_BUCKET,
        ContinuationToken: continuationToken,
      }));
      for (const obj of res.Contents ?? []) {
        sizeBytes += obj.Size ?? 0;
        objectCount++;
      }
      continuationToken = res.NextContinuationToken;
    } while (continuationToken);

    const [{ db_size }] = await app.prisma.$queryRaw<[{ db_size: bigint }]>`
      SELECT pg_database_size(current_database()) AS db_size
    `;

    return { sizeBytes, objectCount, dbSizeBytes: Number(db_size) };
  });

  app.get("/workers", { preHandler: [requireAuth] }, async () => {
    const OCR_QUEUE   = process.env.OCR_QUEUE   ?? "ocr_queue";
    const THUMB_QUEUE = process.env.THUMB_QUEUE ?? "thumb_queue";
    const connection  = buildRedisConnection(app.config.REDIS_URL);

    const ocrQueue   = new Queue(OCR_QUEUE,   { connection });
    const thumbQueue = new Queue(THUMB_QUEUE, { connection });

    try {
      const [ocrWorkers, thumbWorkers] = await Promise.all([
        ocrQueue.getWorkers(),
        thumbQueue.getWorkers(),
      ]);
      const [ocrCounts, thumbCounts] = await Promise.all([
        ocrQueue.getJobCounts("waiting", "active", "delayed", "failed"),
        thumbQueue.getJobCounts("waiting", "active", "delayed", "failed"),
      ]);
      return {
        ocr:   { active: ocrWorkers.length   > 0, count: ocrWorkers.length,   counts: ocrCounts   },
        thumb: { active: thumbWorkers.length > 0, count: thumbWorkers.length, counts: thumbCounts },
      };
    } finally {
      await Promise.allSettled([ocrQueue.close(), thumbQueue.close()]);
    }
  });
};
