// apps/api/src/routes/media.ts
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireAuth } from "../utils/authGuard.js";
import { MEDIA_SORT_OPTIONS } from "../services/media/mediaQueryService.js";
import { getUploadSizeError } from "../lib/media/uploadLimits.js";
import { normalizeTags, TagValidationError } from "../lib/tags/normalizeTags.js";
import type { JobUpdateEvent } from "../plugins/queueEvents.js";

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
  const parseTags = (value: unknown) => {
    try {
      return normalizeTags(value);
    } catch (error) {
      if (error instanceof TagValidationError) throw app.httpErrors.badRequest(error.message);
      throw error;
    }
  };

  // POST media handler - init upload -> return presigned PUT (processing enqueued on finalize)
  app.post("/", { preHandler: [requireAuth] }, async req => {
    const body = z
      .object({
        filename: z.string().min(1),
        mimeType: z.string().min(1),
        sizeBytes: z.number().int().positive(),
        title: z.string().min(1),
        tags: z.unknown().optional(),
      })
      .parse(req.body);

    assertUploadWithinLimit(body);

    const result = await uploadService.initUpload(req.userId!, { ...body, tags: parseTags(body.tags) });
    req.log.info({ filename: body.filename, mimeType: body.mimeType, sizeBytes: body.sizeBytes }, "upload init");
    return result;
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
              tags: z.unknown().optional(),
            }),
          )
          .min(1)
          .max(MAX_BATCH_ITEMS),
      })
      .parse(req.body);

    body.items.forEach(assertUploadWithinLimit);

    const items = body.items.map(item => ({ ...item, tags: parseTags(item.tags) }));

    const result = await uploadService.initBatchUploads(req.userId!, items);
    req.log.info({ count: body.items.length }, "batch upload init");
    return result;
  });

  // POST /media/batch-finalize - mark uploads ready + enqueue processing
  app.post("/batch-finalize", { preHandler: [requireAuth] }, async req => {
    const body = z
      .object({
        ids: z.array(z.string().uuid()).min(1).max(MAX_BATCH_ITEMS),
      })
      .parse(req.body);

    const result = await uploadService.finalizeBatch(req.userId!, body.ids);
    req.log.info({ count: body.ids.length }, "batch upload finalized");
    return result;
  });

  // POST /media/:id/finalize - mark upload ready + enqueue processing
  app.post<{ Params: { id: string } }>(
    "/:id/finalize",
    { preHandler: [requireAuth] },
    async req => {
      const userId = req.userId!;
      const { id } = paramsSchema.parse(req.params);

      const result = await uploadService.finalizeBatch(userId, [id]);
      req.log.info({ mediaId: id }, "upload finalized");
      return result;
    },
  );

  // GET /media - list my media
  app.get("/", { preHandler: [requireAuth] }, async req => {
    const userId = req.userId!;
    const rawQuery = req.query as Record<string, unknown>;
    const Query = z.object({
      q: z.string().trim().optional(),
      search: z.string().trim().optional(),
      tag: z.string().trim().optional(),
      tags: z.unknown().optional(),
      thumbState: z.enum(["PENDING", "READY", "ERROR", "FAILED"]).optional(),
      textState: z.enum(["PENDING", "READY", "ERROR", "FAILED"]).optional(),
      sort: z.enum(SORT_OPTIONS).optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
      cursor: z.string().optional(),
      page: z.coerce.number().int().min(1).optional(),
    });
    const { q, search, tag, tags, thumbState, textState, sort, limit, cursor, page } = Query.parse(
      rawQuery,
    );
    const hasTagsParam = Object.prototype.hasOwnProperty.call(rawQuery, "tags");
    const hasTagParam = Object.prototype.hasOwnProperty.call(rawQuery, "tag");

    if (hasTagParam && hasTagsParam) {
      throw app.httpErrors.badRequest("Use either ?tag=one or ?tags=one,two");
    }

    const tagFilters: string[] = [];
    if (hasTagsParam) {
      const parsed = parseTags(tags);
      if (parsed.length === 0) throw app.httpErrors.badRequest("Provide at least one tag");
      tagFilters.push(...parsed);
    } else if (hasTagParam) {
      const parsed = parseTags(tag);
      if (parsed.length !== 1)
        throw app.httpErrors.badRequest("Use ?tags=... for multiple tag filters");
      tagFilters.push(parsed[0]);
    }

    const queryText = q ?? search;

    return queryService.listMedia(userId, {
      queryText,
      tags: tagFilters,
      thumbState,
      textState,
      sort,
      limit,
      cursor,
      page,
    });
  });

  // GET /media/tags - list top tags for the user
  app.get("/tags", { preHandler: [requireAuth] }, async req => {
    const userId = req.userId!;
    const Query = z.object({
      limit: z.coerce.number().int().min(1).max(200).default(50),
    });
    const { limit } = Query.parse(req.query);

    const tags = await queryService.listTopTags(userId, limit);

    return { tags };
  });

  // GET /media/events - Server-Sent Events stream for job state updates (thumb + text)
  app.get("/events", { preHandler: [requireAuth] }, (req, reply) => {
    const userId = req.userId!;

    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.flushHeaders();

    // Hand off — Fastify will not attempt to send a response after this
    reply.hijack();

    const send = (data: object) => {
      if (!reply.raw.writableEnded) reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // Keep-alive ping every 25 s so proxies/load-balancers don't close idle streams
    const ping = setInterval(() => {
      if (!reply.raw.writableEnded) reply.raw.write(": ping\n\n");
    }, 25_000);

    const listener = (event: JobUpdateEvent) => {
      if (event.userId === userId) {
        send({ mediaId: event.mediaId, field: event.field, value: event.value });
      }
    };

    app.jobEvents.on("update", listener);

    req.raw.once("close", () => {
      clearInterval(ping);
      app.jobEvents.off("update", listener);
      if (!reply.raw.writableEnded) reply.raw.end();
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

      req.log.info({ mediaId: id }, "media deleted");
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
          title: z.string().min(1).optional(),
          tags: z.unknown().optional(),
        })
        .refine(data => data.title !== undefined || data.tags !== undefined, {
          message: "Provide a title or tags to update",
        })
        .parse(req.body);

      const hasTagsField = Object.prototype.hasOwnProperty.call(req.body ?? {}, "tags");
      const tags = hasTagsField ? parseTags(body.tags) : undefined;

      const media = await actionsService.updateMediaMetadata(userId, id, {
        title: body.title,
        tags,
      });

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
          forceOcr: z.boolean().optional(),
        })
        .parse(req.body ?? {});

      const result = await actionsService.enqueueTextExtraction(userId, id, {
        language: body.language,
        rotation: body.rotation,
        forceOcr: body.forceOcr ?? false,
      });

      if (!result) return reply.notFound();

      return reply.send(result);
    },
  );

  // POST /media/:id/text/cancel - cancel text extraction
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

  // GET /media/:id - detail payload (single Prisma query)
  app.get<{ Params: { id: string } }>("/:id", { preHandler: [requireAuth] }, async (req, reply) => {
    const userId = req.userId!;
    const { id } = paramsSchema.parse(req.params);

    const media = await readService.getMediaDetail(userId, id);

    if (!media) return reply.notFound();

    return reply.send(media);
  });

  // POST /media/:id/thumbnail/regenerate - force-requeue thumbnail generation
  app.post<{ Params: { id: string } }>(
    "/:id/thumbnail/regenerate",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const userId = req.userId!;
      const { id } = paramsSchema.parse(req.params);

      const result = await actionsService.regenerateThumbnail(userId, id);
      if (!result) return reply.notFound();

      return reply.send(result);
    },
  );

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
