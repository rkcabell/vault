// apps/api/src/routes/media.ts
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireAuth } from "../utils/authGuard.js";
import { MEDIA_SORT_OPTIONS } from "../services/media/mediaQueryService.js";
import { getUploadSizeError } from "../lib/media/uploadLimits.js";
import { normalizeTags, TagValidationError } from "../lib/tags/normalizeTags.js";
import type { JobUpdateEvent } from "../plugins/queueEvents.js";
import { Queue } from "bullmq";
import { ARCHIVE_MIME_TYPES } from "../services/media/mediaActionsService.js";
import { enqueueUnpack, type UnpackJob, UNPACK_QUEUE } from "../queues/enqueueUnpack.js";
import { buildRedisConnection } from "../lib/config/redis.js";
import { PreferencesService } from "../services/preferencesService.js";
import { PreferencesRepository } from "../repositories/preferencesRepository.js";

const paramsSchema = z.object({ id: z.string().uuid() }).strict();
const SORT_OPTIONS = MEDIA_SORT_OPTIONS;
const MAX_BATCH_ITEMS = 100;
// 1x1 solid-color WebP placeholder to avoid broken images.
const FALLBACK_WEBP_BASE64 =
  "UklGRiwAAABXRUJQVlA4ICAAAABwAQCdASoBAAEAAUAmJZQCdAFAAAD++QRjZQJ+NXuAAA==";
const FALLBACK_WEBP = Buffer.from(FALLBACK_WEBP_BASE64, "base64");

export const mediaRoutes: FastifyPluginAsync = async app => {
  const { uploadService, queryService, readService, actionsService } = app.mediaServices;
  let unpackQueue: Queue<UnpackJob> | null = null;
  const getUnpackQueue = () => {
    if (!unpackQueue) {
      unpackQueue = new Queue<UnpackJob>(UNPACK_QUEUE, { connection: buildRedisConnection(app.config.REDIS_URL) });
    }
    return unpackQueue;
  };
  app.addHook("onClose", async () => {
    if (unpackQueue) await unpackQueue.close();
  });
  const preferencesService = new PreferencesService(new PreferencesRepository(app.prisma));
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

    const userId = req.userId!;
    const result = await uploadService.finalizeBatch(userId, body.ids);
    req.log.info({ count: body.ids.length }, "batch upload finalized");

    // Auto-unpack archives if the user preference is enabled
    const prefs = await preferencesService.getPreferences(userId).catch(() => null);
    if (prefs?.autoUnpackArchives) {
      const archiveItems = await app.prisma.media.findMany({
        where: { id: { in: body.ids }, userId },
        select: { id: true, storageKey: true, mimeType: true },
      });
      for (const item of archiveItems) {
        if (ARCHIVE_MIME_TYPES.has(item.mimeType)) {
          await enqueueUnpack(getUnpackQueue(), {
            mediaId: item.id,
            userId,
            storageKey: item.storageKey,
            mimeType: item.mimeType,
          }).catch(err => req.log.warn({ err, mediaId: item.id }, "failed to enqueue unpack"));
        }
      }
    }

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

      // Auto-unpack if archive and preference enabled
      const prefs = await preferencesService.getPreferences(userId).catch(() => null);
      if (prefs?.autoUnpackArchives) {
        const mediaItem = await app.prisma.media.findFirst({
          where: { id, userId },
          select: { id: true, storageKey: true, mimeType: true },
        });
        if (mediaItem && ARCHIVE_MIME_TYPES.has(mediaItem.mimeType)) {
          await enqueueUnpack(getUnpackQueue(), {
            mediaId: mediaItem.id,
            userId,
            storageKey: mediaItem.storageKey,
            mimeType: mediaItem.mimeType,
          }).catch(err => req.log.warn({ err, mediaId: id }, "failed to enqueue unpack"));
        }
      }

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
      excludeTags: z.string().trim().optional(),
      thumbState: z.enum(["PENDING", "READY", "ERROR", "FAILED"]).optional(),
      textState: z.enum(["PENDING", "READY", "ERROR", "FAILED"]).optional(),
      mimeType: z.string().trim().optional(),
      sort: z.enum(SORT_OPTIONS).optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
      cursor: z.string().optional(),
      excludeUnpacked: z.coerce.boolean().optional(),
    });
    const { q, search, tag, tags, excludeTags: excludeTagsRaw, thumbState, textState, mimeType, sort, limit, cursor, excludeUnpacked } = Query.parse(
      rawQuery,
    );
    const hasTagsParam = Object.prototype.hasOwnProperty.call(rawQuery, "tags");
    const hasTagParam = Object.prototype.hasOwnProperty.call(rawQuery, "tag");

    if (hasTagParam && hasTagsParam) {
      throw app.httpErrors.badRequest("Use either ?tag=one or ?tags=one,two");
    }

    const tagFilters: string[] = [];
    if (hasTagsParam) {
      const parsed = (typeof tags === "string" ? tags.split(",") : []).map(t => t.trim().toLowerCase()).filter(Boolean);
      if (parsed.length === 0) throw app.httpErrors.badRequest("Provide at least one tag");
      tagFilters.push(...parsed);
    } else if (hasTagParam) {
      const parsed = typeof tag === "string" ? tag.trim().toLowerCase() : "";
      if (!parsed) throw app.httpErrors.badRequest("Use ?tags=... for multiple tag filters");
      tagFilters.push(parsed);
    }

    const excludeTagFilters = excludeTagsRaw
      ? excludeTagsRaw.split(",").map(t => t.trim().toLowerCase()).filter(Boolean)
      : [];

    const queryText = q ?? search;

    return queryService.listMedia(userId, {
      queryText,
      tags: tagFilters,
      excludeTags: excludeTagFilters,
      thumbState,
      textState,
      mimeTypePrefix: mimeType,
      excludeUnpacked,
      sort,
      limit,
      cursor,
    });
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

  // POST /media/bulk-download - zip and stream selected items
  app.post(
    "/bulk-download",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const userId = req.userId!;
      const body = z
        .object({ ids: z.array(z.string().uuid()).min(1).max(50) })
        .parse(req.body);

      const items = await actionsService.getBulkDownloadItems(userId, body.ids);

      if (items.length === 0) return reply.notFound();

      reply.raw.setHeader("Content-Type", "application/zip");
      reply.raw.setHeader("Content-Disposition", 'attachment; filename="vault-download.zip"');
      reply.hijack();

      await actionsService.streamBulkArchive(items, reply.raw, req.log);
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

  // POST /media/:id/unpack — extract archive into a bundle
  app.post<{ Params: { id: string } }>(
    "/:id/unpack",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const userId = req.userId!;
      const { id } = paramsSchema.parse(req.params);

      // Gate: must be a recognised archive type
      const media = await app.prisma.media.findFirst({
        where: { id, userId },
        select: { mimeType: true },
      });
      if (!media) return reply.notFound();
      if (!ARCHIVE_MIME_TYPES.has(media.mimeType)) {
        return reply.badRequest("File is not a recognised archive type.");
      }

      const result = await actionsService.unpackArchive(userId, id);

      if (!result) return reply.notFound();
      if (result === "already-linked") {
        return reply.code(409).send({ error: "Archive is already linked to a bundle." });
      }

      req.log.info({ mediaId: id, bundleId: result.bundleId }, "archive unpacked");
      return reply.send({ bundleId: result.bundleId });
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
