import type { FastifyPluginAsync } from "fastify";
import { z, ZodError } from "zod";
import { requireAuth } from "../utils/authGuard.js";
import { MediaRepository } from "../repositories/mediaRepository.js";
import { normalizeTag, TagValidationError } from "../lib/tags/normalizeTags.js";

/**
 * Lists a user's tags for the sidebar, and renames, recolours or deletes one
 * across the whole library.
 */

export const tagsRoutes: FastifyPluginAsync = async app => {
  const repository = new MediaRepository(app.prisma);

  app.get("/", { preHandler: [requireAuth] }, async req => {
    const Query = z.object({
      limit: z.coerce.number().int().min(1).max(200).default(30),
      offset: z.coerce.number().int().min(0).default(0),
      // Comma-separated namespaces, e.g. `facets=type,year,folder`. The caller
      // names them, so the server keeps no second copy of the sidebar's list.
      facets: z.string().trim().min(1).optional(),
    });
    const { limit, offset, facets } = Query.parse(req.query);

    if (facets) {
      const namespaces = [...new Set(
        facets.split(",").map(n => n.trim().toLowerCase()).filter(Boolean),
      )];
      const tags = await repository.listFacetTags(req.userId!, namespaces);
      return {
        tags: tags.map(t => ({ name: t.tag, count: t.count, color: t.color, origin: t.origin })),
        total: tags.length,
        offset: 0,
        limit: tags.length,
      };
    }

    const { tags, total } = await repository.listTopTags(req.userId!, limit, offset);

    return {
      tags: tags.map(t => ({ name: t.tag, count: t.count, color: t.color, origin: t.origin })),
      total,
      offset,
      limit,
    };
  });

  app.patch("/:tag", { preHandler: [requireAuth] }, async req => {
    const Params = z.object({ tag: z.string().min(1) });
    const Body = z.object({
      name: z.string().min(1).optional(),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
      origin: z.enum(["USER", "AUTO"]).optional(),
    });

    const { tag: rawTag } = Params.parse(req.params);

    let body: z.infer<typeof Body>;
    try {
      body = Body.parse(req.body);
    } catch (err) {
      if (err instanceof ZodError) throw app.httpErrors.badRequest(err.errors[0]?.message ?? "Invalid request body");
      throw err;
    }

    if (body.name === undefined && body.color === undefined && body.origin === undefined) {
      throw app.httpErrors.badRequest("Provide name, color, or origin to update.");
    }

    let tag: string;
    try {
      tag = normalizeTag(rawTag);
    } catch (err) {
      if (err instanceof TagValidationError) throw app.httpErrors.badRequest(err.message);
      throw err;
    }

    if (body.name !== undefined) {
      let newName: string;
      try {
        newName = normalizeTag(body.name);
      } catch (err) {
        if (err instanceof TagValidationError) throw app.httpErrors.badRequest(err.message);
        throw err;
      }
      if (newName === tag) return { ok: true, tag, newName };
      const affected = await repository.renameTag(req.userId!, tag, newName);
      return { ok: true, tag, newName, affected };
    }

    // Each is applied only when the request carried it, so setting the origin
    // does not also clear the colour.
    if (body.color !== undefined) {
      await repository.setTagColor(req.userId!, tag, body.color);
    }
    if (body.origin !== undefined) {
      await repository.setTagOrigin(req.userId!, tag, body.origin);
    }
    return { ok: true, tag };
  });

  // Orphaned means no media row of this user's still references the tag.
  app.delete("/orphaned", { preHandler: [requireAuth] }, async req => {
    const deleted = await repository.deleteOrphanTags(req.userId!);
    return { ok: true, deleted };
  });

  app.delete("/:tag", { preHandler: [requireAuth] }, async req => {
    const Params = z.object({ tag: z.string().min(1) });
    const { tag: rawTag } = Params.parse(req.params);

    let tag: string;
    try {
      tag = normalizeTag(rawTag);
    } catch (err) {
      if (err instanceof TagValidationError) {
        throw app.httpErrors.badRequest(err.message);
      }
      throw err;
    }

    const affected = await repository.deleteTag(req.userId!, tag);

    return { ok: true, tag, affected };
  });
};
