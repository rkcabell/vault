import type { FastifyPluginAsync } from "fastify";
import { HeadBucketCommand } from "@aws-sdk/client-s3";

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get("/healthz", async () => ({ ok: true }));

  app.get("/readyz", async (_req, reply) => {
    const [db, redis, s3] = await Promise.allSettled([
      app.prisma.$queryRaw`SELECT 1`,
      app.redis.ping(),
      app.s3.send(new HeadBucketCommand({ Bucket: app.config.S3_BUCKET })),
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
