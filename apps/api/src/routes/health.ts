/**
 * Answers the two questions a container runtime asks: is the process alive,
 * and can it reach the database, Redis and its storage folder.
 */
import type { FastifyPluginAsync } from "fastify";
import { access, constants } from "node:fs/promises";

declare module "fastify" {
  interface FastifyInstance {
    /** Stands in for the real storage check so a test does not touch the disk. */
    storageReadyCheck?: () => Promise<void>;
  }
}

// Confirms the storage folder can be written to. A folder that does not exist
// yet counts as healthy, because the storage adapter creates it on first write.
async function defaultStorageCheck (basePath: string): Promise<void> {
  try {
    await access(basePath, constants.W_OK);
  } catch (err) {
    if ((err as { code?: string }).code !== "ENOENT") throw err;
  }
}

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get("/healthz", async () => ({ ok: true }));

  app.get("/readyz", async (_req, reply) => {
    const storageCheck = app.storageReadyCheck
      ? app.storageReadyCheck()
      : defaultStorageCheck(app.config.STORAGE_FS_PATH);

    const [db, redis, storage] = await Promise.allSettled([
      app.prisma.$queryRaw`SELECT 1`,
      app.redis.ping(),
      storageCheck,
    ]);

    const services = {
      db:      db.status      === "fulfilled" ? "healthy" : "degraded",
      redis:   redis.status   === "fulfilled" ? "healthy" : "degraded",
      storage: storage.status === "fulfilled" ? "healthy" : "degraded",
    };
    const ready = Object.values(services).every(s => s === "healthy");
    return reply.code(ready ? 200 : 503).send({ ready, services });
  });
};
