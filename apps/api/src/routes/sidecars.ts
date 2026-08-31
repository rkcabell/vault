import type { FastifyPluginAsync } from "fastify";
import type { SidecarStatus } from "@vault/types";
import { requireAuth } from "../utils/authGuard.js";
import { SIDECAR_SNAPSHOT } from "../lib/http/rateLimits.js";

/**
 * Reads the state of a user's metadata snapshot, writes one on demand, and
 * starts a restore from one. The scheduled export runs on its own elsewhere.
 */

export const sidecarRoutes: FastifyPluginAsync = async app => {
  const requireService = () => {
    const service = app.sidecarService;
    // Absent means SIDECAR_EXPORT_ENABLED=false. 503 rather than 404: the route
    // exists, the feature is turned off.
    if (!service) throw app.httpErrors.serviceUnavailable("Snapshot export is disabled on this server");
    return service;
  };

  // Answers even with the service off, so the settings card can tell "snapshots
  // are on" apart from "the server will never write one".
  app.get("/", { preHandler: [requireAuth] }, async (req): Promise<SidecarStatus> => {
    const service = app.sidecarService;
    if (service) return service.getStatus(req.userId!);
    const { sidecarMode } = await app.preferencesService.getPreferences(req.userId!);
    return { enabled: false, mode: sidecarMode, snapshot: null, restore: null };
  });

  app.post("/export", { preHandler: [requireAuth, app.userRateLimit("sidecar-export", SIDECAR_SNAPSHOT)] }, async (req, reply) => {
    const result = await requireService().exportSnapshot(req.userId!, { force: true });
    // Null only when sidecarMode is off — force skips the change probe.
    if (!result) return reply.badRequest("Snapshots are turned off for this account");
    req.log.info({ userId: req.userId, entries: result.entries }, "sidecar snapshot exported on request");
    return reply.send(result);
  });

  // Reattaches the snapshot's metadata to the library as it stands now.
  app.post("/restore", { preHandler: [requireAuth, app.userRateLimit("sidecar-restore", SIDECAR_SNAPSHOT)] }, async (req, reply) => {
    const status = await requireService().getStatus(req.userId!);
    if (!status.snapshot) return reply.notFound("There is no snapshot to restore from");

    const { started } = await requireService().startRestore(req.userId!);
    if (!started) return reply.conflict("A restore is already running");
    req.log.warn({ userId: req.userId, snapshot: status.snapshot }, "sidecar restore started");
    return reply.send({ started: true });
  });
};
