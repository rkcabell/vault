/**
 * Serves the duplicates review page: which items are byte-for-byte copies of
 * each other, and starting the scan that finds them.
 */
import type { FastifyPluginAsync } from "fastify";
import { requireAuth } from "../../utils/authGuard.js";
import { DUPLICATES_SCAN } from "../../lib/http/rateLimits.js";

export const mediaDuplicatesRoutes: FastifyPluginAsync = async app => {
  const { dedupService } = app.mediaServices;

  // Groups of items with the same content, plus how many items have not been
  // hashed yet, so the page can say the answer is incomplete.
  app.get("/duplicates", { preHandler: [requireAuth] }, async req => {
    return dedupService.listDuplicateGroups(req.userId!);
  });

  // Queues a hash for every item that lacks one. Items are hashed as they are
  // read, so this only fills in the gaps.
  app.post("/duplicates/scan", { preHandler: [requireAuth, app.userRateLimit("duplicates-scan", DUPLICATES_SCAN)] }, async req => {
    return dedupService.startScan(req.userId!);
  });
};
