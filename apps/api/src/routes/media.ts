// apps/api/src/routes/media.ts
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import crypto from "crypto";
import { requireAuth } from "../utils/authGuard.js";
import { makeQueueClient } from "../queues/queueClient.js";
import { makeEnqueueThumbnails } from "../queues/enqueueThumbnail.js";

const paramsSchema = z.object({ id: z.string().uuid() }).strict();

export const mediaRoutes: FastifyPluginAsync = async app => {
  const BUCKET = app.config.S3_BUCKET;

  // POST media handler — init upload → return presigned PUT + enqueue OCR job
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

  // GET /media — list my media
  app.get("/", { preHandler: [requireAuth] }, async req => {
    const userId = req.userId!;
    const Query = z.object({ q: z.string().optional() });
    const { q } = Query.parse(req.query);

    const items = await app.prisma.media.findMany({
      where: {
        userId,
        ...(q
          ? {
              OR: [
                { title: { contains: q, mode: "insensitive" } },
                { document: { is: { rawText: { contains: q, mode: "insensitive" } } } },
              ],
            }
          : {}),
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, title: true, status: true, createdAt: true },
    });

    return { items };
  });

  // GET /media/:id — detail + presigned GET
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

  // GET /media/:id/thumbnail — presigned GET to the thumbnail (404 if missing)
  app.get(
  "/:id/thumbnail",
  { preHandler: [requireAuth] },
  async (req, reply) => {
    const userId = req.userId!;
    const { id } = paramsSchema.parse(req.params);

      // Enforce ownership and fetch only what we need
      const media = await app.prisma.media.findFirst({
        where: { id, userId },
        select: { thumbnailKey: true },
      });

      // Use a generic 404 to avoid leaking whether the media exists
      if (!media?.thumbnailKey) return reply.notFound();

      const cmd = new GetObjectCommand({
        Bucket: app.config.S3_BUCKET,
        Key: media.thumbnailKey,
      });

      const url = await getSignedUrl(app.s3, cmd, { expiresIn: 600 }); // 10 minutes
      return reply.send({ url });
    },
  );
};
