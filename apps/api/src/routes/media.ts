// apps/api/src/routes/media.ts
import type { FastifyPluginAsync } from "fastify";
import { Queue, type ConnectionOptions } from "bullmq";
import { z } from "zod";
import {
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import crypto from "crypto";
import { requireAuth } from "../utils/authGuard.js";
import { makeEnqueueThumbnails, type ThumbJob } from "../queues/enqueueThumbnail.js";

const paramsSchema = z.object({ id: z.string().uuid() }).strict();
const OCR_QUEUE = process.env.OCR_QUEUE ?? "ocr_queue";
const THUMB_QUEUE = process.env.THUMB_QUEUE ?? "thumb_queue";

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

  type ObjectState = "exists" | "missing" | "unknown";
  const getObjectState = async (key: string): Promise<ObjectState> => {
    try {
      await app.s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
      return "exists";
    } catch (err) {
      return isNotFoundError(err) ? "missing" : "unknown";
    }
  };

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
  "[media] enqueue after upload"
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

  // GET /media - list my media
  app.get("/", { preHandler: [requireAuth] }, async req => {
    const userId = req.userId!;
    const Query = z.object({
      q: z.string().trim().optional(),
      search: z.string().trim().optional(),
      tag: z.string().trim().optional(),
      thumbState: z.enum(["PENDING", "READY", "ERROR"]).optional(),
      textState: z.enum(["PENDING", "READY", "ERROR"]).optional(),
      sort: z.enum(["createdAt_desc", "createdAt_asc"]).optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
      cursor: z.string().optional(),
      page: z.coerce.number().int().min(1).optional(),
    });
    const { q, search, tag, thumbState, textState, sort, limit, cursor, page } = Query.parse(
      req.query,
    );
    const queryText = q ?? search;
    const take = limit ?? 24;
    const orderBy =
      sort === "createdAt_asc"
        ? [{ createdAt: "asc" as const }, { id: "asc" as const }]
        : [{ createdAt: "desc" as const }, { id: "desc" as const }];

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
        thumbnailKey: true,
        storageKey: true,
        mimeType: true,
      },
    });

    const hasMore = items.length > take;
    const sliced = hasMore ? items.slice(0, take) : items;
    const nextCursor = hasMore ? sliced[sliced.length - 1]?.id ?? null : null;
    const nextPage = page && hasMore ? page + 1 : null;

    type ObjectState = "exists" | "missing" | "unknown";
    type PresentState = Exclude<ObjectState, "missing">; // "exists" | "unknown"
    type MediaRow = typeof sliced[number];
    type VisibleEntry = { item: MediaRow; state: PresentState };

    const visible: Array<VisibleEntry | null> = await Promise.all(
      sliced.map(async item => {
        const state = await getObjectState(item.storageKey);
        if (state === "missing") return null;
        return { item, state: state as PresentState };
      }),
    );

    const filtered = visible.filter((e): e is VisibleEntry => e !== null);

    const responseItems = filtered
      .map(entry => {
        const { storageKey: _storageKey, ...rest } = entry.item;
        return { ...rest };
      })
      .filter((item): item is Omit<MediaRow, "storageKey"> => item !== null);

    return { items: responseItems, nextCursor, nextPage };
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

  // GET /media/:id - detail + presigned GET
  app.get<{ Params: { id: string } }>("/:id", { preHandler: [requireAuth] }, async (req, reply) => {
    const userId = req.userId!;
    const m = await app.prisma.media.findFirst({
      where: { id: req.params.id, userId },
    });
    if (!m) return reply.notFound();

    const getCmd = new GetObjectCommand({ Bucket: BUCKET, Key: m.storageKey });
    const downloadUrl = await getSignedUrl(app.s3, getCmd, { expiresIn: 600 });

    return { media: m, downloadUrl };
  });

  // GET /media/:id/thumbnail - presigned GET to the thumbnail
  app.get("/:id/thumbnail", { preHandler: [requireAuth] }, async (req, reply) => {
    const userId = req.userId!;
    const { id } = paramsSchema.parse(req.params);

    const media = await app.prisma.media.findFirst({
      where: { id, userId },
      select: { thumbnailKey: true, storageKey: true, mimeType: true },
    });

    if (!media) return reply.notFound();

    const fallbackKey =
      !media.thumbnailKey && media.mimeType.startsWith("image/") ? media.storageKey : null;
    const key = media.thumbnailKey ?? fallbackKey;
    if (!key) return reply.notFound();

    const cmd = new GetObjectCommand({
      Bucket: app.config.S3_BUCKET,
      Key: key,
    });

    const url = await getSignedUrl(app.s3, cmd, { expiresIn: 600 }); // 10 minutes
    return reply.send({ url });
  });
};
