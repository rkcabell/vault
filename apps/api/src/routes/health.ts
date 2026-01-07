import type { FastifyPluginAsync } from "fastify";

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get("/healthz", async () => ({ ok: true }));
  // Ready check will later verify DB, Redis, MinIO. For now, same as health.
  // app.get("/readyz", async () => ({ ready: true }));

  app.get("/readyz", async () => {
    // DB ping
    await app.prisma.$queryRaw`SELECT 1`;
    return { ready: true };
  });
};
