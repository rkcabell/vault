import fp from "fastify-plugin";
import { MediaRepository } from "../repositories/mediaRepository.js";
import { SidecarRepository } from "../repositories/sidecarRepository.js";
import { createSidecarService, type SidecarService } from "../services/sidecar/sidecarService.js";
import { createRedisRestoreStore } from "../lib/sidecar/restoreState.js";

/**
 * Starts the periodic snapshot of every user's library metadata. It runs in the
 * API process because there is exactly one of those.
 *
 * SIDECAR_EXPORT_ENABLED=false stops the loop without changing anyone's
 * `sidecarMode`, for an install that backs Postgres up another way.
 */

declare module "fastify" {
  interface FastifyInstance {
    /** Undefined when SIDECAR_EXPORT_ENABLED=false — treat as "off", not a failure. */
    sidecarService?: SidecarService;
  }
}

export default fp(
  async app => {
    if (process.env.SIDECAR_EXPORT_ENABLED === "false") {
      app.log.warn({}, "sidecar export disabled (SIDECAR_EXPORT_ENABLED=false): library metadata will not be snapshotted");
      return;
    }

    const mediaRepository = new MediaRepository(app.prisma);
    const service = createSidecarService({
      repository: new SidecarRepository(app.prisma),
      storage: app.storage,
      bucket: app.config.STORAGE_BUCKET,
      logger: app.log,
      getMode: async userId => (await app.preferencesService.getPreferences(userId)).sidecarMode,
      getIntervalMinutes: async userId => (await app.preferencesService.getPreferences(userId)).sidecarIntervalMinutes,
      listUserIds: async () => (await app.prisma.user.findMany({ select: { id: true } })).map(u => u.id),
      reconcileTagCounts: userId => mediaRepository.reconcileTagCounts(userId),
      restoreStore: createRedisRestoreStore(app.redis),
      intervalMs: parseEnvNumber("SIDECAR_EXPORT_INTERVAL_MS"),
    });

    app.decorate("sidecarService", service);
    service.start();
    app.log.info({}, "sidecar snapshot exporter started");

    app.addHook("onClose", async () => {
      await service.stop();
    });
  },
  { name: "sidecar", dependencies: ["prisma", "storage", "preferencesService", "redis"] },
);

function parseEnvNumber (name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}
