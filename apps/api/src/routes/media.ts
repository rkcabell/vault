// apps/api/src/routes/media.ts
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireAuth } from "../utils/authGuard.js";
import { MEDIA_SORT_OPTIONS } from "../services/media/mediaQueryService.js";
import { getUploadSizeError } from "../lib/media/uploadLimits.js";

const paramsSchema = z.object({ id: z.string().uuid() }).strict();
const SORT_OPTIONS = MEDIA_SORT_OPTIONS;
const MAX_BATCH_ITEMS = 100;
// 1x1 solid-color WebP placeholder to avoid broken images.
const FALLBACK_WEBP_BASE64 =
  "UklGRiwAAABXRUJQVlA4ICAAAABwAQCdASoBAAEAAUAmJZQCdAFAAAD++QRjZQJ+NXuAAA==";
const FALLBACK_WEBP = Buffer.from(FALLBACK_WEBP_BASE64, "base64");

export const mediaRoutes: FastifyPluginAsync = async app => {
  const { uploadService, queryService, readService, actionsService } = app.mediaServices;
  const assertUploadWithinLimit = (file: { filename: string; mimeType: string; sizeBytes: number }) => {
    const error = getUploadSizeError(file);
    if (error) throw app.httpErrors.badRequest(error);
  };

  // POST media handler - init upload -> return presigned PUT + enqueue OCR job
  app.post("/", { preHandler: [requireAuth] }, async req => {
    const body = z
      .object({
        filename: z.string().min(1),
        mimeType: z.string().min(1),
        sizeBytes: z.number().int().positive(),
        title: z.string().min(1),
        tags: z.array(z.string()).default([]),
      })
      .parse(req.body);

    assertUploadWithinLimit(body);

    return uploadService.initUpload(req.userId!, body);
  });

  // POST /media/batch-init - init uploads in one DB transaction
  app.post("/batch-init", { preHandler: [requireAuth] }, async req => {
    const body = z
      .object({
        items: z
          .array(
            z.object({
              filename: z.string().trim().min(1),
              mimeType: z.string().trim().min(1),
              sizeBytes: z.number().int().positive(),
              title: z.string().trim().min(1).optional(),
              tags: z.array(z.string().trim().min(1)).default([]),
            }),
          )
          .min(1)
          .max(MAX_BATCH_ITEMS),
      })
      .parse(req.body);

    body.items.forEach(assertUploadWithinLimit);

    return uploadService.initBatchUploads(req.userId!, body.items);
  });

  // POST /media/batch-finalize - mark uploads ready + enqueue processing
  app.post("/batch-finalize", { preHandler: [requireAuth] }, async req => {
    const body = z
      .object({
        ids: z.array(z.string().uuid()).min(1).max(MAX_BATCH_ITEMS),
      })
      .parse(req.body);

    return uploadService.finalizeBatch(req.userId!, body.ids);
  });

  // GET /media - list my media
  app.get("/", { preHandler: [requireAuth] }, async req => {
    const userId = req.userId!;
    const Query = z.object({
      q: z.string().trim().optional(),
      search: z.string().trim().optional(),
      tag: z.string().trim().optional(),
      thumbState: z.enum(["PENDING", "READY", "ERROR", "FAILED"]).optional(),
      textState: z.enum(["PENDING", "READY", "ERROR", "FAILED"]).optional(),
      sort: z.enum(SORT_OPTIONS).optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
      cursor: z.string().optional(),
      page: z.coerce.number().int().min(1).optional(),
    });
    const { q, search, tag, thumbState, textState, sort, limit, cursor, page } = Query.parse(
      req.query,
    );
    const queryText = q ?? search;

    return queryService.listMedia(userId, {
      queryText,
      tag,
      thumbState,
      textState,
      sort,
      limit,
      cursor,
      page,
    });
  });

  // DELETE /media/:id - delete my media
  app.delete<{ Params: { id: string } }>(
    "/:id",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const userId = req.userId!;
      const { id } = paramsSchema.parse(req.params);

      const result = await actionsService.deleteMedia(userId, id);

      if (!result) return reply.notFound();

      return reply.send(result);
    },
  );

  // PATCH /media/:id - update media metadata
  app.patch<{ Params: { id: string } }>(
    "/:id",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const userId = req.userId!;
      const { id } = paramsSchema.parse(req.params);
      const body = z
        .object({
          title: z.string().min(1),
        })
        .parse(req.body);

      const media = await actionsService.updateMediaTitle(userId, id, body.title);

      if (!media) return reply.notFound();

      return reply.send({ media });
    },
  );

  // GET /media/:id/download - presigned GET for the original file
  app.get<{ Params: { id: string } }>(
    "/:id/download",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const userId = req.userId!;
      const { id } = paramsSchema.parse(req.params);

      const url = await actionsService.getDownloadUrl(userId, id);

      if (!url) return reply.notFound();

      return reply.send(url);
    },
  );

  // GET /media/:id/text - chunked extracted text
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

  // POST /media/:id/text - re-run text extraction
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
        })
        .parse(req.body ?? {});

      const result = await actionsService.enqueueTextExtraction(userId, id, {
        language: body.language,
        rotation: body.rotation,
        forceOcr: false,
      });

      if (!result) return reply.notFound();

      return reply.send(result);
    },
  );

  // GET /media/:id - detail payload (single Prisma query)
  app.get<{ Params: { id: string } }>("/:id", { preHandler: [requireAuth] }, async (req, reply) => {
    const userId = req.userId!;
    const { id } = paramsSchema.parse(req.params);

    const media = await readService.getMediaDetail(userId, id);

    if (!media) return reply.notFound();

    return reply.send(media);
  });

  // GET /media/:id/thumbnail - stream thumbnail bytes or fallback
  app.get("/:id/thumbnail", { preHandler: [requireAuth] }, async (req, reply) => {
    const parsed = paramsSchema.safeParse(req.params);
    if (!parsed.success) {
      reply.header("Cache-Control", "public, max-age=31536000, immutable");
      reply.type("image/webp");
      return reply.send(FALLBACK_WEBP);
    }

    const thumb = await readService.getThumbnail(parsed.data.id);

    if (thumb?.body) {
      reply.header("Cache-Control", "public, max-age=31536000, immutable");
      if (thumb.etag) reply.header("ETag", thumb.etag);
      reply.type("image/webp");
      return reply.send(thumb.body);
    }

    reply.header("Cache-Control", "public, max-age=31536000, immutable");
    reply.type("image/webp");
    return reply.send(FALLBACK_WEBP);
  });
};
