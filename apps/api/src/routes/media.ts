// apps/api/src/routes/media.ts
import type { FastifyPluginAsync } from "fastify";
import { Queue, type ConnectionOptions } from "bullmq";
import { z } from "zod";
import { PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Prisma } from "@prisma/client";
import crypto from "crypto";
import { requireAuth } from "../utils/authGuard.js";
import {
  computeThumbKey,
  makeEnqueueThumbnails,
  type ThumbJob,
} from "../queues/enqueueThumbnail.js";

const paramsSchema = z.object({ id: z.string().uuid() }).strict();
const OCR_QUEUE = process.env.OCR_QUEUE ?? "ocr_queue";
const THUMB_QUEUE = process.env.THUMB_QUEUE ?? "thumb_queue";
const SORT_OPTIONS = [
  "createdAt_desc",
  "createdAt_asc",
  "title_asc",
  "title_desc",
  "size_desc",
  "size_asc",
  "mimeType_asc",
] as const;
const MAX_BATCH_ITEMS = 100;
// 1x1 solid-color WebP placeholder to avoid broken images.
const FALLBACK_WEBP_BASE64 =
  "UklGRiwAAABXRUJQVlA4ICAAAABwAQCdASoBAAEAAUAmJZQCdAFAAAD++QRjZQJ+NXuAAA==";
const FALLBACK_WEBP = Buffer.from(FALLBACK_WEBP_BASE64, "base64");

function deriveTitle (filename: string, title?: string | null): string {
  if (title && title.trim()) return title.trim();
  const trimmed = filename.trim();
  const base = trimmed.replace(/\.[^/.]+$/, "");
  return base || trimmed || "Untitled";
}

function isNotFoundError (err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const meta = (err as { $metadata?: { httpStatusCode?: number } }).$metadata;
  if (meta?.httpStatusCode === 404) return true;
  const name = (err as { name?: string }).name;
  return name === "NotFound" || name === "NoSuchKey";
}

export const mediaRoutes: FastifyPluginAsync = async app => {
  const BUCKET = app.config.S3_BUCKET;
  let queueConnection: ConnectionOptions | null = null;

  const getQueueConnection = () => {
    if (!queueConnection) {
      const parsed = new URL(app.config.REDIS_URL);
      queueConnection = {
        host: parsed.hostname,
        port: parsed.port ? Number(parsed.port) : 6379,
        username: parsed.username || undefined,
        password: parsed.password || undefined,
        db: parsed.pathname ? Number(parsed.pathname.replace("/", "")) || 0 : 0,
        tls: parsed.protocol === "rediss:" ? {} : undefined,
      };
    }
    return queueConnection;
  };

  const ocrQueue = new Queue(OCR_QUEUE, {
    connection: getQueueConnection(),
  });

  const thumbQueue = new Queue<ThumbJob>(THUMB_QUEUE, {
    connection: getQueueConnection(),
  });

  app.addHook("onClose", async () => {
    await Promise.allSettled([ocrQueue.close(), thumbQueue.close()]);
  });

  const deleteObjectIfPresent = async (key: string) => {
    try {
      await app.s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
    } catch (err) {
      if (!isNotFoundError(err)) {
        throw err;
      }
    }
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

    const userId = req.userId!;
    const id = crypto.randomUUID();
    const storageKey = `${userId}/${id}/${body.filename}`;

    const media = await app.prisma.media.create({
      data: {
        id,
        userId,
        thumbState: "PENDING",
        textState: "PENDING",
        sourceState: "READY",
        storageKey,
        filename: body.filename,
        mimeType: body.mimeType,
        sizeBytes: body.sizeBytes,
        title: body.title,
        tags: body.tags,
      },
      select: { id: true, storageKey: true, title: true },
    });

    // 1) enqueue the thumbnail job
    const enqueueThumb = makeEnqueueThumbnails(thumbQueue);

    await enqueueThumb({
      mediaId: media.id,
      userId,
      storageKey,
      size: 512,
    });

    app.log.info(
      { mediaId: media.id, storageKey, mimeType: body.mimeType },
      "[media] enqueue after upload",
    );

    // 2) Presigned upload URL
    const putCmd = new PutObjectCommand({
      Bucket: BUCKET,
      Key: storageKey,
      ContentType: body.mimeType,
    });
    const uploadUrl = await getSignedUrl(app.s3, putCmd, { expiresIn: 600 });

    // 3) Enqueue OCR job (native PDF extraction happens in the worker)
    await ocrQueue.add(
      "ocr",
      {
        mediaId: media.id,
        userId,
        storageKey,
        title: media.title,
      },
      { attempts: 5, backoff: { type: "exponential", delay: 2000 } },
    );

    // 4) Return what is ready to use
    return { id: media.id, uploadUrl, storageKey: media.storageKey };
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

    const userId = req.userId!;
    const items = body.items.map(item => {
      const id = crypto.randomUUID();
      const storageKey = `${userId}/${id}/${item.filename}`;
      return {
        id,
        userId,
        storageKey,
        filename: item.filename,
        mimeType: item.mimeType,
        sizeBytes: item.sizeBytes,
        title: deriveTitle(item.filename, item.title),
        tags: item.tags ?? [],
        thumbState: "PENDING" as const,
        textState: "PENDING" as const,
        sourceState: "PENDING" as const,
      };
    });

    await app.prisma.$transaction(async tx => {
      await tx.media.createMany({ data: items });
    });

    const signedItems = await Promise.all(
      items.map(async item => {
        const putCmd = new PutObjectCommand({
          Bucket: BUCKET,
          Key: item.storageKey,
          ContentType: item.mimeType,
        });
        const putUrl = await getSignedUrl(app.s3, putCmd, { expiresIn: 600 });
        return { id: item.id, storageKey: item.storageKey, putUrl };
      }),
    );

    return { items: signedItems };
  });

  // POST /media/batch-finalize - mark uploads ready + enqueue processing
  app.post("/batch-finalize", { preHandler: [requireAuth] }, async req => {
    const body = z
      .object({
        ids: z.array(z.string().uuid()).min(1).max(MAX_BATCH_ITEMS),
      })
      .parse(req.body);

    const userId = req.userId!;
    const ids = Array.from(new Set(body.ids));

    if (ids.length === 0) {
      return { ok: true, count: 0 };
    }

    const mediaItems = await app.prisma.$queryRaw<{ id: string; storageKey: string }[]>`
      UPDATE "Media"
      SET "sourceState" = 'READY'
      WHERE "userId" = ${userId} AND "id" IN (${Prisma.join(ids)})
      RETURNING "id", "storageKey"
    `;

    if (mediaItems.length === 0) {
      return { ok: true, count: 0 };
    }

    const thumbJobs = mediaItems.map(item => ({
      name: "thumb",
      data: {
        type: "thumb" as const,
        mediaId: item.id,
        userId,
        storageKey: item.storageKey,
        outKey: computeThumbKey(item.id),
        size: 512,
      },
      opts: { jobId: item.id, attempts: 5, backoff: { type: "exponential", delay: 2000 } },
    }));

    const ocrJobs = mediaItems.map(item => ({
      name: "ocr",
      data: {
        mediaId: item.id,
        userId,
        storageKey: item.storageKey,
      },
      opts: { attempts: 5, backoff: { type: "exponential", delay: 2000 } },
    }));

    await Promise.all([
      thumbJobs.length ? thumbQueue.addBulk(thumbJobs) : Promise.resolve(),
      ocrJobs.length ? ocrQueue.addBulk(ocrJobs) : Promise.resolve(),
    ]);

    return { ok: true, count: mediaItems.length };
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
    const take = limit ?? 24;
    const orderBy = (() => {
      switch (sort) {
        case "createdAt_asc":
          return [{ createdAt: "asc" as const }, { id: "asc" as const }];
        case "title_asc":
          return [{ title: "asc" as const }, { id: "asc" as const }];
        case "title_desc":
          return [{ title: "desc" as const }, { id: "desc" as const }];
        case "size_asc":
          return [{ sizeBytes: "asc" as const }, { id: "asc" as const }];
        case "size_desc":
          return [{ sizeBytes: "desc" as const }, { id: "desc" as const }];
        case "mimeType_asc":
          return [{ mimeType: "asc" as const }, { id: "asc" as const }];
        default:
          return [{ createdAt: "desc" as const }, { id: "desc" as const }];
      }
    })();

    const items = await app.prisma.media.findMany({
      where: {
        userId,
        ...(queryText
          ? {
              OR: [
                { title: { contains: queryText, mode: "insensitive" } },
                { document: { is: { rawText: { contains: queryText, mode: "insensitive" } } } },
              ],
            }
          : {}),
        ...(tag ? { tags: { has: tag } } : {}),
        ...(thumbState ? { thumbState } : {}),
        ...(textState ? { textState } : {}),
      },
      orderBy,
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : page ? { skip: (page - 1) * take } : {}),
      select: {
        id: true,
        title: true,
        thumbState: true,
        textState: true,
        createdAt: true,
        tags: true,
        mimeType: true,
      },
    });

    const hasMore = items.length > take;
    const sliced = hasMore ? items.slice(0, take) : items;
    const nextCursor = hasMore ? sliced[sliced.length - 1]?.id ?? null : null;
    const nextPage = page && hasMore ? page + 1 : null;

    return { items: sliced, nextCursor, nextPage };
  });

  // DELETE /media/:id - delete my media
  app.delete<{ Params: { id: string } }>(
    "/:id",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const userId = req.userId!;
      const { id } = paramsSchema.parse(req.params);

      const media = await app.prisma.media.findFirst({
        where: { id, userId },
        select: { storageKey: true, thumbnailKey: true },
      });

      if (!media) return reply.notFound();

      try {
        await deleteObjectIfPresent(media.storageKey);
        if (media.thumbnailKey) {
          await deleteObjectIfPresent(media.thumbnailKey);
        }
      } catch {
        return reply.code(500).send({ error: "Failed to delete media" });
      }

      await app.prisma.media.delete({ where: { id } });

      return reply.send({ ok: true });
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

      const existing = await app.prisma.media.findFirst({
        where: { id, userId },
        select: { id: true },
      });

      if (!existing) return reply.notFound();

      const media = await app.prisma.media.update({
        where: { id },
        data: { title: body.title },
        select: {
          id: true,
          title: true,
          filename: true,
          sizeBytes: true,
          mimeType: true,
          thumbState: true,
          textState: true,
        },
      });

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

      const media = await app.prisma.media.findFirst({
        where: { id, userId },
        select: { storageKey: true },
      });

      if (!media) return reply.notFound();

      const getCmd = new GetObjectCommand({ Bucket: BUCKET, Key: media.storageKey });
      const url = await getSignedUrl(app.s3, getCmd, { expiresIn: 600 });

      return reply.send({ url });
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

      const media = await app.prisma.media.findFirst({
        where: { id, userId },
        select: {
          mimeType: true,
          document: { select: { rawText: true, textSource: true } },
        },
      });

      if (!media) return reply.notFound();

      const rawText = media.document?.rawText ?? "";
      const totalLength = rawText.length;
      const text = rawText.slice(offset, offset + limit);
      const hasMore = offset + text.length < totalLength;
      const textSource =
        media.document?.textSource ?? (media.mimeType.startsWith("text/") ? "NATIVE" : "UNKNOWN");

      return reply.send({
        text,
        offset,
        limit,
        totalLength,
        hasMore,
        textSource,
      });
    },
  );

  // POST /media/:id/ocr - re-run OCR with options
  app.post<{ Params: { id: string } }>(
    "/:id/ocr",
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

      const media = await app.prisma.media.findFirst({
        where: { id, userId },
        select: { id: true, storageKey: true, title: true },
      });

      if (!media) return reply.notFound();

      await ocrQueue.add(
        "ocr",
        {
          mediaId: media.id,
          userId,
          storageKey: media.storageKey,
          title: media.title,
          language: body.language,
          rotation: body.rotation,
          forceOcr: true,
        },
        { attempts: 5, backoff: { type: "exponential", delay: 2000 } },
      );
      await app.prisma.media.update({
        where: { id },
        data: { textState: "PENDING" },
      });

      return reply.send({ ok: true });
    },
  );

  // GET /media/:id - detail payload (single Prisma query)
  app.get<{ Params: { id: string } }>("/:id", { preHandler: [requireAuth] }, async (req, reply) => {
    const userId = req.userId!;
    const { id } = paramsSchema.parse(req.params);

    const media = await app.prisma.media.findFirst({
      where: { id, userId },
      select: {
        id: true,
        userId: true,
        title: true,
        filename: true,
        mimeType: true,
        sizeBytes: true,
        storageKey: true,
        createdAt: true,
        updatedAt: true,
        tags: true,
        thumbState: true,
        thumbError: true,
        textState: true,
        thumbnailKey: true,
        document: {
          select: {
            rawText: true,
            textSource: true,
          },
        },
      },
    });
    if (!media) return reply.notFound();

    const rawText = media.document?.rawText ?? "";
    const textTotalLength = rawText.length;
    const textSource =
      media.document?.textSource ??
      (media.mimeType.startsWith("text/") ? "NATIVE" : "UNKNOWN");

    const { document: _document, ...mediaPayload } = media;

    return reply.send({
      media: {
        ...mediaPayload,
        hasText: textTotalLength > 0,
        hasThumb: Boolean(media.thumbnailKey),
      },
      document: media.document
        ? {
            rawText,
            textSource,
            textTotalLength,
          }
        : null,
      permissions: {
        canEdit: true,
        canDelete: true,
        canDownload: true,
        canOcr: true,
      },
    });
  });

  // GET /media/:id/thumbnail - stream thumbnail bytes or fallback
  app.get("/:id/thumbnail", { preHandler: [requireAuth] }, async (req, reply) => {
    const parsed = paramsSchema.safeParse(req.params);
    if (!parsed.success) {
      reply.header("Cache-Control", "public, max-age=31536000, immutable");
      reply.type("image/webp");
      return reply.send(FALLBACK_WEBP);
    }

    const thumbKey = computeThumbKey(parsed.data.id);
    try {
      const res = await app.s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: thumbKey }));
      if (res.Body) {
        reply.header("Cache-Control", "public, max-age=31536000, immutable");
        if (res.ETag) reply.header("ETag", res.ETag);
        reply.type("image/webp");
        return reply.send(res.Body);
      }
    } catch (err) {
      if (!isNotFoundError(err)) {
        app.log.warn({ err, thumbKey }, "[media] thumbnail fetch failed");
      }
    }

    reply.header("Cache-Control", "public, max-age=31536000, immutable");
    reply.type("image/webp");
    return reply.send(FALLBACK_WEBP);
  });
};
