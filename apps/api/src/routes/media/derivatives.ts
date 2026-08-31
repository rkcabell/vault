/**
 * Serves the derived-content routes: reading extracted text, and asking for
 * text or a thumbnail to be produced again.
 */
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireAuth } from "../../utils/authGuard.js";
import {
  DERIVATIVE_PROMOTE,
  DERIVATIVE_REQUEUE,
  EXTRACT_ALL_SCANNED,
} from "../../lib/http/rateLimits.js";
import { paramsSchema } from "./shared.js";

/** Acting on one item and acting on many are the same operations, so they are kept together. */
export const mediaDerivativesRoutes: FastifyPluginAsync = async app => {
  const { readService, actionsService } = app.mediaServices;

  // A window of an item's extracted text, so a long document is read a piece at
  // a time.
  app.get<{ Params: { id: string } }>(
    "/:id/text",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const userId = req.userId!;
      const { id } = paramsSchema.parse(req.params);
      const Query = z.object({
        offset: z.coerce.number().int().min(0).default(0),
        limit: z.coerce.number().int().min(1).max(20000).default(4000),
      });
      const { offset, limit } = Query.parse(req.query);

      const text = await readService.getTextChunk(userId, id, offset, limit);

      if (!text) return reply.notFound();

      return reply.send(text);
    },
  );

  // Reads an item's text again. `forceOcr` asks for the slow reading pass even
  // where the fast one would normally be tried first.
  app.post<{ Params: { id: string } }>(
    "/:id/text",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const userId = req.userId!;
      const { id } = paramsSchema.parse(req.params);
      const body = z
        .object({
          language: z.string().trim().min(2).max(12).optional(),
          rotation: z.enum(["0", "90", "180", "270"]).optional(),
          forceOcr: z.boolean().optional(),
        })
        .parse(req.body ?? {});

      // The permitted folders travel with the job, so the worker checks the
      // file's path against the list as it stood when the user asked.
      const prefs = await app.preferencesService.getPreferences(userId).catch(() => null);
      const allowedRoots = prefs?.indexAllowedRoots ?? [];

      const result = await actionsService.enqueueTextExtraction(userId, id, {
        language: body.language,
        rotation: body.rotation,
        forceOcr: body.forceOcr ?? false,
      }, allowedRoots);

      if (!result) return reply.notFound();

      return reply.send(result);
    },
  );

  // Stops an extraction that has not finished.
  app.post<{ Params: { id: string } }>(
    "/:id/text/cancel",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const userId = req.userId!;
      const { id } = paramsSchema.parse(req.params);

      const result = await actionsService.cancelTextExtraction(userId, id);

      if (!result) return reply.notFound();

      return reply.send(result);
    },
  );

  // Renders an item's thumbnail again, discarding the one it has.
  app.post<{ Params: { id: string } }>(
    "/:id/thumbnail/regenerate",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const userId = req.userId!;
      const { id } = paramsSchema.parse(req.params);

      // The permitted folders travel with the job; see the text route above.
      const prefs = await app.preferencesService.getPreferences(userId).catch(() => null);
      const allowedRoots = prefs?.indexAllowedRoots ?? [];

      const result = await actionsService.regenerateThumbnail(userId, id, allowedRoots);
      if (!result) return reply.notFound();

      return reply.send(result);
    },
  );

  // The batch paths sit under /batch rather than /:id so Fastify does not read
  // "batch" as an item id. Each takes a list of ids.
  const batchBodySchema = z.object({ ids: z.array(z.string().min(1)).min(1).max(500) });

  const parseBatchBody = (body: unknown): string[] => {
    const parsed = batchBodySchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw app.httpErrors.badRequest(parsed.error.errors[0]?.message ?? "Invalid request body");
    }
    return parsed.data.ids;
  };

  // Renders thumbnails again for many items at once.
  app.post("/batch/thumbnail", { preHandler: [requireAuth, app.userRateLimit("batch-thumbnail", DERIVATIVE_REQUEUE)] }, async (req, reply) => {
    const userId = req.userId!;
    const ids = parseBatchBody(req.body);

    // The permitted folders travel with the job; see the single-item route above.
    const prefs = await app.preferencesService.getPreferences(userId).catch(() => null);
    const allowedRoots = prefs?.indexAllowedRoots ?? [];

    const result = await actionsService.regenerateThumbnailsBatch(userId, ids, allowedRoots);
    return reply.send(result);
  });

  // Reads text again for many items at once.
  app.post("/batch/text", { preHandler: [requireAuth, app.userRateLimit("batch-text", DERIVATIVE_REQUEUE)] }, async (req, reply) => {
    const userId = req.userId!;
    const ids = parseBatchBody(req.body);

    const prefs = await app.preferencesService.getPreferences(userId).catch(() => null);
    const allowedRoots = prefs?.indexAllowedRoots ?? [];

    const result = await actionsService.enqueueTextExtractionBatch(userId, ids, allowedRoots);
    return reply.send(result);
  });

  // Reads the text of scanned documents that were set aside for it.
  //
  // The fast pass has already run on every one of these and found no text, so
  // this is a clear request for the slow reading pass. The number handled at
  // once is limited, because each file takes minutes of processor time.
  const extractAllBodySchema = z.object({ limit: z.number().int().positive().optional() });

  app.post("/batch/text/scanned", { preHandler: [requireAuth, app.userRateLimit("extract-all-scanned", EXTRACT_ALL_SCANNED)] }, async (req, reply) => {
    const userId = req.userId!;
    const parsed = extractAllBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw app.httpErrors.badRequest(parsed.error.errors[0]?.message ?? "Invalid request body");
    }

    const prefs = await app.preferencesService.getPreferences(userId).catch(() => null);
    const allowedRoots = prefs?.indexAllowedRoots ?? [];

    const result = await actionsService.extractAllScannedText(userId, allowedRoots, parsed.data.limit);
    return reply.send(result);
  });

  // Moves the thumbnails for the items currently on screen to the front of the
  // queue.
  //
  // The library grid sends its visible ids each time scrolling stops. Nothing is
  // re-rendered and no finished item is touched, so this is safe to send that
  // often. No feeder means the user has switched derived work off, which is
  // answered with zero counts rather than an error.
  app.post("/batch/thumbnail/prioritize", { preHandler: [requireAuth, app.userRateLimit("promote-thumbnail", DERIVATIVE_PROMOTE)] }, async (req, reply) => {
    const userId = req.userId!;
    const ids = parseBatchBody(req.body);

    const feeder = app.derivativeFeeder;
    if (!feeder) return reply.send({ queued: 0, reordered: 0 });

    const result = await feeder.promoteThumbnails(userId, ids);
    return reply.send(result);
  });

  // How many items are ahead of this one in the queue for text.
  app.get<{ Params: { id: string } }>(
    "/:id/text/queue-position",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const userId = req.userId!;
      const { id } = paramsSchema.parse(req.params);

      const position = await readService.getTextQueuePosition(userId, id);
      if (!position) return reply.notFound();

      return reply.send(position);
    },
  );

  // Moves the text for the named items to the front of the queue.
  //
  // This only affects the fast pass. Asking for the slow reading pass is the
  // separate `forceOcr` option above, because it takes minutes per file.
  app.post("/batch/text/prioritize", { preHandler: [requireAuth, app.userRateLimit("promote-text", DERIVATIVE_PROMOTE)] }, async (req, reply) => {
    const userId = req.userId!;
    const ids = parseBatchBody(req.body);

    const feeder = app.derivativeFeeder;
    if (!feeder) return reply.send({ queued: 0, reordered: 0 });

    const result = await feeder.promoteText(userId, ids);
    return reply.send(result);
  });
};
