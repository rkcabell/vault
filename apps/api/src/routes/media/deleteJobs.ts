/**
 * Serves bulk deletion: starting one, watching it, and stopping it.
 */
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireAuth } from "../../utils/authGuard.js";

/** Deleting one item is in items.ts; everything here works on many at once. */
export const mediaDeleteJobRoutes: FastifyPluginAsync = async app => {
  const { deleteService } = app.mediaServices;

  // Starts a deletion and answers straight away with a job to follow. The work
  // happens in the delete worker, so a selection of any size returns at once.
  //
  // A body of ids deletes exactly those items. Filters in the query string
  // instead delete everything they match, and no filters at all deletes the
  // user's entire library.
  app.delete("/", { preHandler: [requireAuth] }, async (req, reply) => {
    const userId = req.userId!;

    const Body = z.object({ ids: z.array(z.string().min(1)).optional() }).optional();
    const ids = Body.parse(req.body ?? undefined)?.ids;

    if (ids && ids.length > 0) {
      const { jobId } = await deleteService.startDelete(userId, { ids });
      req.log.info({ userId, jobId, idCount: ids.length }, "bulk delete enqueued (ids)");
      return reply.code(202).send({ jobId });
    }

    const Query = z.object({
      q: z.string().trim().optional(),
      tags: z.unknown().optional(),
      excludeTags: z.string().trim().optional(),
      thumbState: z.enum(["PENDING", "READY", "ERROR", "FAILED", "UNSUPPORTED"]).optional(),
      textState: z.enum(["PENDING", "READY", "ERROR", "FAILED", "UNSUPPORTED", "NEEDS_OCR"]).optional(),
      excludeUnpacked: z.coerce.boolean().optional(),
      // This list must match the filters the library listing accepts. A filter
      // accepted there but missing here widens a deletion from what the user
      // could see to everything they own.
      missing: z.literal("only").optional(),
    });
    const { q, tags, excludeTags: excludeTagsRaw, thumbState, textState, excludeUnpacked, missing } = Query.parse(req.query as Record<string, unknown>);

    const tagFilters = typeof tags === "string" ? tags.split(",").map(t => t.trim().toLowerCase()).filter(Boolean) : [];
    const excludeTagFilters = excludeTagsRaw ? excludeTagsRaw.split(",").map(t => t.trim().toLowerCase()).filter(Boolean) : [];

    const { jobId } = await deleteService.startDelete(userId, {
      filters: {
        queryText: q,
        tags: tagFilters,
        excludeTags: excludeTagFilters,
        thumbState,
        textState,
        excludeUnpacked,
        missing,
      },
    });
    req.log.info({ userId, jobId }, "bulk delete enqueued (filter)");
    return reply.code(202).send({ jobId });
  });

  // Progress for one deletion.
  app.get("/delete/status", { preHandler: [requireAuth] }, async (req, reply) => {
    const userId = req.userId!;
    const { jobId } = z.object({ jobId: z.string().min(1) }).parse(req.query);

    const status = await deleteService.getStatus(userId, jobId);
    if (!status) return reply.notFound();
    return reply.send(status);
  });

  // The user's running deletion, so a reloaded page can pick it back up.
  // Answers with a null status when nothing is running.
  app.get("/delete/active", { preHandler: [requireAuth] }, async req => {
    const status = await deleteService.getActive(req.userId!);
    return { status };
  });

  // Stops every running deletion for every user. Work already done is not
  // undone.
  app.post("/delete/abort", { preHandler: [requireAuth] }, async (req, reply) => {
    const userId = req.userId!;
    const result = await deleteService.abort();
    req.log.warn({ userId, ...result }, "bulk delete aborted");
    return reply.send(result ?? { epoch: null });
  });
};
