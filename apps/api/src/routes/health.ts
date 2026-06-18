import type { FastifyPluginAsync } from "fastify";
import { HeadBucketCommand } from "@aws-sdk/client-s3";
import { access, constants } from "node:fs/promises";

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get("/healthz", async () => ({ ok: true }));

  app.get("/readyz", async (_req, reply) => {
    // Storage health is backend-specific: HeadBucket for S3, a writability
    // probe on the base path for the filesystem backend.
    const storageCheck =
      app.config.STORAGE_DRIVER === "s3"
        ? app.s3!.send(new HeadBucketCommand({ Bucket: app.config.S3_BUCKET }))
        : access(app.config.STORAGE_FS_PATH!, constants.W_OK).catch((err: unknown) => {
            // ENOENT = base path not created yet (first boot, no uploads yet).
            // The fs adapter creates it lazily on first write, so this is healthy.
            if ((err as { code?: string }).code !== "ENOENT") throw err;
          });

    const [db, redis, s3] = await Promise.allSettled([
      app.prisma.$queryRaw`SELECT 1`,
      app.redis.ping(),
      storageCheck,
    ]);

    const services = {
      db:    db.status    === "fulfilled" ? "healthy" : "degraded",
      redis: redis.status === "fulfilled" ? "healthy" : "degraded",
      s3:    s3.status    === "fulfilled" ? "healthy" : "degraded",
    };
    const ready = Object.values(services).every(s => s === "healthy");
    return reply.code(ready ? 200 : 503).send({ ready, services });
  });
};
