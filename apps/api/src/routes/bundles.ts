import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireAuth } from "../utils/authGuard.js";
import { BundleRepository } from "../repositories/bundleRepository.js";

export const bundlesRoutes: FastifyPluginAsync = async app => {
  const repo = new BundleRepository(app.prisma);

  // GET / — list user's bundles
  app.get("/", { preHandler: [requireAuth] }, async req => {
    const bundles = await repo.listBundles(req.userId!);
    return { bundles };
  });

  // POST / — create bundle
  app.post("/", { preHandler: [requireAuth] }, async (req, reply) => {
    const Body = z.object({
      name: z.string().min(1).max(200),
      description: z.string().max(1000).optional(),
    });
    const { name, description } = Body.parse(req.body);
    const bundle = await repo.createBundle(req.userId!, name, description);
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
    const data = Body.parse(req.body);
    const updated = await repo.updateBundle(id, req.userId!, data);
    if (!updated) return reply.notFound();
    req.log.info({ bundleId: id }, "bundle updated");
    return { ok: true };
  });

  // DELETE /:id — delete bundle
  app.delete("/:id", { preHandler: [requireAuth] }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await repo.deleteBundle(id, req.userId!);
    req.log.info({ bundleId: id }, "bundle deleted");
    reply.code(204);
  });

  // POST /:id/items — add media to bundle
  app.post("/:id/items", { preHandler: [requireAuth] }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const Body = z.object({
      mediaIds: z.array(z.string()).min(1).max(100),
    });
    const { mediaIds } = Body.parse(req.body);
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

  // PUT /:id/items/order — reorder items
  app.put("/:id/items/order", { preHandler: [requireAuth] }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const Body = z.object({
      orderedIds: z.array(z.string()).min(1),
    });
    const { orderedIds } = Body.parse(req.body);
    const ok = await repo.reorderItems(id, req.userId!, orderedIds);
    if (!ok) return reply.notFound();
    return { ok: true };
  });
};
