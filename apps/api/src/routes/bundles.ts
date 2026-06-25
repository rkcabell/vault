import type { FastifyPluginAsync } from "fastify";
import { z, ZodError } from "zod";
import { requireAuth } from "../utils/authGuard.js";
import { BundleRepository } from "../repositories/bundleRepository.js";

export const bundlesRoutes: FastifyPluginAsync = async app => {
  const repo = new BundleRepository(app.prisma);

  function parseBody<S extends z.ZodTypeAny>(schema: S, body: unknown): z.infer<S> {
    try {
      return schema.parse(body);
    } catch (err) {
      if (err instanceof ZodError) throw app.httpErrors.badRequest(err.errors[0]?.message ?? "Invalid request body");
      throw err;
    }
  }

  // GET / — list user's bundles
  app.get("/", { preHandler: [requireAuth] }, async req => {
    const { q } = z.object({ q: z.string().optional() }).parse(req.query);
    const bundles = await repo.listBundles(req.userId!, q?.trim() || undefined);
    return { bundles };
  });

  // POST / — create bundle
  app.post("/", { preHandler: [requireAuth] }, async (req, reply) => {
    const Body = z.object({
      name: z.string().min(1).max(200),
      description: z.string().max(1000).optional(),
      coverMediaId: z.string().nullable().optional(),
    });
    const { name, description, coverMediaId } = parseBody(Body, req.body);
    const bundle = await repo.createBundle(req.userId!, name, description, coverMediaId ?? undefined);
    req.log.info({ bundleId: bundle.id, name }, "bundle created");
    reply.code(201);
    return { bundle };
  });

  // GET /:id — get bundle detail with items
  app.get("/:id", { preHandler: [requireAuth] }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const bundle = await repo.getBundleById(id, req.userId!);
    if (!bundle) return reply.notFound();
    return { bundle };
  });

  // PATCH /:id — update name/description/starred/coverMediaId
  app.patch("/:id", { preHandler: [requireAuth] }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const Body = z.object({
      name: z.string().min(1).max(200).optional(),
      description: z.string().max(1000).nullable().optional(),
      starred: z.boolean().optional(),
      coverMediaId: z.string().nullable().optional(),
    });
    const data = parseBody(Body, req.body);
    const updated = await repo.updateBundle(id, req.userId!, data);
    if (!updated) return reply.notFound();
    req.log.info({ bundleId: id }, "bundle updated");
    return { ok: true };
  });

  // DELETE /:id — delete bundle
  app.delete("/:id", { preHandler: [requireAuth] }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const userId = req.userId!;

    const result = await repo.deleteBundleWithCascade(id, userId);

    if (!result.found) return reply.notFound();

    // If this bundle was created by unpacking an archive, delete all extracted
    // media items that are not members of any other bundle.
    if (result.extractedMediaIds.length > 0) {
      const stillMembered = await app.prisma.bundleItem.findMany({
        where: { mediaId: { in: result.extractedMediaIds } },
        select: { mediaId: true },
      });
      const stillMemberedSet = new Set(stillMembered.map(r => r.mediaId));
      const toDelete = result.extractedMediaIds.filter(mid => !stillMemberedSet.has(mid));
      await Promise.all(
        toDelete.map(mid => app.mediaServices.actionsService.deleteMedia(userId, mid)),
      );
      req.log.info({ bundleId: id, deleted: toDelete.length }, "cleaned up extracted media");
    }

    req.log.info({ bundleId: id }, "bundle deleted");
    reply.code(204);
  });

  // POST /:id/items — add media to bundle
  app.post("/:id/items", { preHandler: [requireAuth] }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const Body = z.object({
      mediaIds: z.array(z.string()).min(1).max(100),
    });
    const { mediaIds } = parseBody(Body, req.body);
    const ok = await repo.addItems(id, req.userId!, mediaIds);
    if (!ok) return reply.notFound();
    req.log.info({ bundleId: id, count: mediaIds.length }, "items added to bundle");
    return { ok: true };
  });

  // DELETE /:id/items/:mediaId — remove item from bundle
  app.delete("/:id/items/:mediaId", { preHandler: [requireAuth] }, async (req, reply) => {
    const { id, mediaId } = z.object({ id: z.string(), mediaId: z.string() }).parse(req.params);
    const ok = await repo.removeItem(id, req.userId!, mediaId);
    if (!ok) return reply.notFound();
    req.log.info({ bundleId: id }, "item removed from bundle");
    reply.code(204);
  });

  // POST /:id/star — toggle starred
  app.post("/:id/star", { preHandler: [requireAuth] }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const starred = await repo.toggleStar(id, req.userId!);
    if (starred === null) return reply.notFound();
    req.log.info({ bundleId: id, starred }, "bundle star toggled");
    return { ok: true, starred };
  });

  // GET /:id/export — stream all bundle items as a zip
  app.get("/:id/export", { preHandler: [requireAuth] }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const userId = req.userId!;

    const exportData = await repo.getBundleItemsForExport(id, userId);
    if (!exportData) return reply.notFound();

    const prefs = await app.preferencesService.getPreferences(userId).catch(() => null);
    const allowedRoots = prefs?.indexAllowedRoots ?? [];

    const safeName = exportData.name.replace(/[/\\:*?"<>|]/g, "").trim() || "bundle";
    reply.raw.setHeader("Content-Type", "application/zip");
    reply.raw.setHeader("Content-Disposition", `attachment; filename="${safeName}.zip"`);
    reply.hijack();

    await app.mediaServices.actionsService.streamBulkArchive(
      exportData.items,
      reply.raw,
      req.log,
      allowedRoots,
    );
  });

  // PUT /:id/items/order — reorder items
  app.put("/:id/items/order", { preHandler: [requireAuth] }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const Body = z.object({
      orderedIds: z.array(z.string()).min(1),
    });
    const { orderedIds } = parseBody(Body, req.body);
    const ok = await repo.reorderItems(id, req.userId!, orderedIds);
    if (!ok) return reply.notFound();
    return { ok: true };
  });
};
