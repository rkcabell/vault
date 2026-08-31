/**
 * Serves the folder scanning routes: starting a scan or a reconcile, and
 * following one that is running.
 */
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireAuth } from "../../utils/authGuard.js";
import { INDEX_SCAN, RECONCILE } from "../../lib/http/rateLimits.js";

/**
 * Starts scans and reports on them.
 *
 * Stopping a scan is POST /api/jobs/cancel-scan instead, because it has to
 * empty the queue and this file has no access to it.
 */
export const mediaIndexingRoutes: FastifyPluginAsync = async app => {
  const { indexService, reconcileService } = app.mediaServices;

  // The folders the user has permitted scanning. An empty list means scanning
  // is switched off.
  app.get("/index/roots", { preHandler: [requireAuth] }, async (req) => {
    const userId = req.userId!;
    const prefs = await app.preferencesService.getPreferences(userId).catch(() => null);
    const roots = prefs?.indexAllowedRoots ?? [];
    return { enabled: roots.length > 0, roots };
  });

  // Scans a folder and adds the files in it to the library, leaving them where
  // they are. Settings decide what is passed over; the request only names the
  // folder.
  app.post("/index", { preHandler: [requireAuth, app.userRateLimit("index-scan", INDEX_SCAN)] }, async (req, reply) => {
    const userId = req.userId!;
    const body = z
      .object({
        path: z.string().min(1),
        recursive: z.boolean().optional(),
      })
      .parse(req.body);

    const prefs = await app.preferencesService.getPreferences(userId).catch(() => null);
    const allowedRoots = prefs?.indexAllowedRoots ?? [];
    const ignoreHidden = prefs?.ignoreHiddenFiles ?? true;
    const blacklistExtensions = prefs?.indexBlacklistExtensions ?? [];
    const excludeFolders = prefs?.indexExcludeFolders ?? [];
    const skipNonContent = prefs?.indexSkipNonContent ?? true;

    const result = await indexService.startIndex(userId, {
      path: body.path,
      recursive: body.recursive ?? true,
      ignoreHidden,
      blacklistExtensions,
      excludeFolders,
      skipNonContent,
    }, allowedRoots);

    if (!result.ok) {
      switch (result.reason) {
        case "disabled":
          return reply.badRequest("In-place indexing is disabled — add at least one allowed folder in Settings.");
        case "not_allowed":
          return reply.forbidden("That folder is not within an allowed indexing root.");
        case "not_found":
          return reply.notFound("Folder not found.");
        case "not_dir":
          return reply.badRequest("That path is not a directory.");
        case "already_running":
          return reply.conflict(
            "A scan is already running. Wait for it to finish, or press Cancel scan to stop it.",
          );
      }
    }

    req.log.info({ userId, path: body.path, jobId: result.jobId }, "index scan requested");
    return reply.send({ jobId: result.jobId });
  });

  // Progress for one scan.
  app.get("/index/status", { preHandler: [requireAuth] }, async (req, reply) => {
    const userId = req.userId!;
    const { jobId } = z.object({ jobId: z.string().min(1) }).parse(req.query);

    const status = await indexService.getStatus(userId, jobId);
    if (!status) return reply.notFound();
    return reply.send(status);
  });

  // The user's running scan, so a reloaded page can pick it back up. Answers
  // with a null status when nothing is running.
  app.get("/index/active", { preHandler: [requireAuth] }, async req => {
    const status = await indexService.getActive(req.userId!);
    return { status };
  });

  // Compares the permitted folders against the library and settles the
  // differences. A scan only ever adds files it has not seen; this also notices
  // files deleted, moved or edited while Vault was not running. Naming a
  // `path` narrows it to that one folder.
  app.post("/index/reconcile", { preHandler: [requireAuth, app.userRateLimit("reconcile", RECONCILE)] }, async (req, reply) => {
    const userId = req.userId!;
    const body = z.object({ path: z.string().min(1).optional() }).parse(req.body ?? {});

    const prefs = await app.preferencesService.getPreferences(userId).catch(() => null);
    const result = await reconcileService.startReconcile(userId, {
      ...(body.path !== undefined ? { path: body.path } : {}),
      allowedRoots: prefs?.indexAllowedRoots ?? [],
      ignoreHidden: prefs?.ignoreHiddenFiles ?? true,
      blacklistExtensions: prefs?.indexBlacklistExtensions ?? [],
      excludeFolders: prefs?.indexExcludeFolders ?? [],
      skipNonContent: prefs?.indexSkipNonContent ?? true,
    });

    if (!result.ok) {
      switch (result.reason) {
        case "disabled":
          return reply.badRequest("In-place indexing is disabled — add at least one allowed folder in Settings.");
        case "not_allowed":
          return reply.forbidden("That folder is not within an allowed indexing root.");
      }
    }

    req.log.info({ userId, path: body.path ?? null, jobIds: result.jobIds }, "reconcile requested");
    return reply.send({ jobIds: result.jobIds });
  });

  // The reconcile now running, and the last one that finished.
  app.get("/index/reconcile/state", { preHandler: [requireAuth] }, async req => {
    return reconcileService.getState(req.userId!);
  });
};
