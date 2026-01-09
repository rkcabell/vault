// apps/api/src/routes/media.ts
import type { FastifyPluginAsync } from "fastify";
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
import { makeQueueClient } from "../queues/queueClient.js";
import { makeEnqueueThumbnails } from "../queues/enqueueThumbnail.js";

const paramsSchema = z.object({ id: z.string().uuid() }).strict();

function isNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const meta = (err as { $metadata?: { httpStatusCode?: number } }).$metadata;
  if (meta?.httpStatusCode === 404) return true;
  const name = (err as { name?: string }).name;
  return name === "NotFound" || name === "NoSuchKey";
}

export const mediaRoutes: FastifyPluginAsync = async app => {
  const BUCKET = app.config.S3_BUCKET;
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

    const userId = req.userId!; // set by authGuard
    const id = crypto.randomUUID();
    const storageKey = `${userId}/${id}/${body.filename}`;

    const media = await app.prisma.media.create({
      data: {
        id,
        userId,
        status: "PENDING",
        storageKey,
        filename: body.filename,
        mimeType: body.mimeType,
        sizeBytes: body.sizeBytes,
        title: body.title,
        tags: body.tags,
      },
      select: { id: true, storageKey: true, title: true },
    });

    // 1) enqueue the thumbnail job (worker will create the WebP when the original arrives)
    const q = makeQueueClient(app.redis);
    const enqueueThumb = makeEnqueueThumbnails(q);

    await enqueueThumb({
      mediaId: media.id,
      userId,
      storageKey, // S3 key for the original file
      size: 512, // defaults to 512
    });

    // 2) Presigned upload URL
    const putCmd = new PutObjectCommand({
      Bucket: BUCKET,
      Key: storageKey,
      ContentType: body.mimeType,
    });
    const uploadUrl = await getSignedUrl(app.s3, putCmd, { expiresIn: 600 });

    // 3) Enqueue a stub OCR job for the worker to process
    const job = JSON.stringify({
      type: "ocr",
      mediaId: media.id,
      userId,
      storageKey,
      title: media.title,
    });

    await app.redis.lpush("ocr:queue", job);

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
      status: z.enum(["PENDING", "READY", "FAILED"]).optional(),
      sort: z.enum(["createdAt_desc", "createdAt_asc"]).optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
      cursor: z.string().optional(),
      page: z.coerce.number().int().min(1).optional(),
    });
    const { q, search, tag, status, sort, limit, cursor, page } = Query.parse(req.query);
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
        ...(status ? { status } : {}),
      },
      orderBy,
      take: take + 1,
      ...(cursor
        ? { cursor: { id: cursor }, skip: 1 }
        : page
          ? { skip: (page - 1) * take }
          : {}),
      select: {
        id: true,
        title: true,
        status: true,
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

    const visible = await Promise.all(
      sliced.map(async item => {
        const state = await getObjectState(item.storageKey);
        if (state === "missing") return null;
        return { item, state };
      }),
    );
    type MediaRow = (typeof sliced)[number];
    const filtered = visible.filter(
      (entry): entry is { item: MediaRow; state: ObjectState } => entry !== null,
    );

    const readyIds = filtered
      .filter(entry => entry.state === "exists" && entry.item.status === "PENDING")
      .map(entry => entry.item.id);

    if (readyIds.length > 0) {
      await app.prisma.media.updateMany({
        where: { id: { in: readyIds }, status: "PENDING" },
        data: { status: "READY" },
      });
    }

    const responseItems = filtered
      .map(entry => {
        const { storageKey: _storageKey, status: originalStatus, ...rest } = entry.item;
        const resolvedStatus =
          entry.state === "exists" && originalStatus === "PENDING" ? "READY" : originalStatus;
        if (status && resolvedStatus !== status) return null;
        return { ...rest, status: resolvedStatus };
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

  // GET /media/:id - detail + presigned GET
  app.get<{ Params: { id: string } }>(
    "/:id",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const userId = req.userId!;
      const m = await app.prisma.media.findFirst({
        where: { id: req.params.id, userId },
        include: { document: true },
      });
      if (!m) return reply.notFound();

      const getCmd = new GetObjectCommand({ Bucket: BUCKET, Key: m.storageKey });
      const downloadUrl = await getSignedUrl(app.s3, getCmd, { expiresIn: 600 });

      return { media: m, downloadUrl };
    },
  );

  // GET /media/:id/thumbnail - presigned GET to the thumbnail
  app.get(
    "/:id/thumbnail",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const userId = req.userId!;
      const { id } = paramsSchema.parse(req.params);

      const media = await app.prisma.media.findFirst({
        where: { id, userId },
        select: { thumbnailKey: true, storageKey: true, mimeType: true },
      });

      if (!media) return reply.notFound();

      const fallbackKey =
        !media.thumbnailKey && media.mimeType.startsWith("image/")
          ? media.storageKey
          : null;
      const key = media.thumbnailKey ?? fallbackKey;
      if (!key) return reply.notFound();

      const cmd = new GetObjectCommand({
        Bucket: app.config.S3_BUCKET,
        Key: key,
      });

      const url = await getSignedUrl(app.s3, cmd, { expiresIn: 600 }); // 10 minutes
      return reply.send({ url });
    },
  );
};
