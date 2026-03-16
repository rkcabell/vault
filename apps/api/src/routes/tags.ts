//File: apps/api/src/routes/tags.ts
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireAuth } from "../utils/authGuard.js";
import { normalizeTags, TagValidationError } from "../lib/tags/normalizeTags.js";
import { MediaRepository } from "../repositories/mediaRepository.js";

export const tagsRoutes: FastifyPluginAsync = async app => {
  const repository = new MediaRepository(app.prisma);

  app.get("/", { preHandler: [requireAuth] }, async req => {
    const Query = z.object({
      limit: z.coerce.number().int().min(1).max(200).default(50),
    });
    const { limit } = Query.parse(req.query);

    const tags = await repository.listTopTags(req.userId!, limit);

    return {
      tags: tags.map(t => ({ name: t.tag, count: t.count })),
    };
  });

  app.delete("/:tag", { preHandler: [requireAuth] }, async req => {
    const Params = z.object({ tag: z.string() });
    const { tag: rawTag } = Params.parse(req.params);

    let tag: string;
    try {
      tag = normalizeTags(rawTag)[0]!;
    } catch (err) {
      if (err instanceof TagValidationError) throw app.httpErrors.badRequest(err.message);
      throw err;
    }

    await repository.deleteTag(req.userId!, tag);

    return { ok: true, tag };
  });
};
