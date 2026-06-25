import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { execFile, spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { requireAuth } from "../utils/authGuard.js";
import { MEDIA_SORT_OPTIONS } from "../services/media/mediaQueryService.js";
import { getUploadSizeError } from "../lib/media/uploadLimits.js";
import { normalizeTags, TagValidationError } from "../lib/tags/normalizeTags.js";
import type { JobUpdateEvent } from "../plugins/queueEvents.js";
import { Queue } from "bullmq";
import { ARCHIVE_MIME_TYPES } from "../lib/media/archiveTypes.js";
import { enqueueUnpack, type UnpackJob, UNPACK_QUEUE } from "../queues/enqueueUnpack.js";
import { buildRedisConnection } from "../lib/config/redis.js";
import type { PrismaClient } from "@prisma/client";
import { isUnderAllowedRoot } from "../lib/media/indexRoots.js";

type MinLogger = { warn: (obj: object, msg: string) => void };

function revealInExplorer (p: string, log: MinLogger) {
  if (process.platform === "win32") {
    // explorer.exe is quirky about /select: it needs the literal command line
    //   explorer.exe /select,"<path>"
    // with quotes around the PATH ONLY. Two traps to avoid:
    //   1. `cmd /c start` splits on the comma in `/select,` → broken flag.
    //   2. Node's default arg quoting wraps the WHOLE `/select,<path>` token in
    //      quotes when the path has spaces → explorer ignores /select and opens
    //      the default folder (looks like the "wrong folder" opened).
    // windowsVerbatimArguments passes our string through unaltered so we place
    // the quotes exactly where explorer wants them. Windows filenames can't
    // contain `"`, so the quoting can't be broken out of — no injection risk.
    const winPath = p.replace(/\//g, "\\");
    const child = spawn("explorer.exe", [`/select,"${winPath}"`], {
      windowsVerbatimArguments: true,
      detached: true,
      stdio: "ignore",
    });
    // 'error' fires only on spawn failure; explorer's nonzero exit is not surfaced.
    child.on("error", err => log.warn({ err, path: p }, "reveal in explorer failed"));
    child.unref();
  } else if (process.platform === "darwin") {
    execFile("open", ["-R", p], err => {
      if (err) log.warn({ err, path: p }, "reveal in explorer failed");
    });
  } else {
    execFile("xdg-open", [path.dirname(p)], err => {
      if (err) log.warn({ err, path: p }, "reveal in explorer failed");
    });
  }
}

async function autoUnpackIfEnabled(
  ids: string[],
  userId: string,
  autoUnpack: boolean,
  getQueue: () => Queue<UnpackJob>,
  prisma: PrismaClient,
  log: { warn: (obj: unknown, msg: string) => void },
): Promise<void> {
  if (!autoUnpack) return;
  const archiveItems = await prisma.media.findMany({
    where: { id: { in: ids }, userId },
    select: { id: true, storageKey: true, mimeType: true },
  });
  for (const item of archiveItems) {
    if (ARCHIVE_MIME_TYPES.has(item.mimeType)) {
      await enqueueUnpack(getQueue(), {
        mediaId: item.id,
        userId,
        storageKey: item.storageKey,
        mimeType: item.mimeType,
      }).catch((err: unknown) => log.warn({ err, mediaId: item.id }, "failed to enqueue unpack"));
    }
  }
}

const paramsSchema = z.object({ id: z.string().uuid() }).strict();
const SORT_OPTIONS = MEDIA_SORT_OPTIONS;
const MAX_BATCH_ITEMS = 100;
// 1x1 solid-color WebP placeholder to avoid broken images.
const FALLBACK_WEBP_BASE64 =
  "UklGRiwAAABXRUJQVlA4ICAAAABwAQCdASoBAAEAAUAmJZQCdAFAAAD++QRjZQJ+NXuAAA==";
const FALLBACK_WEBP = Buffer.from(FALLBACK_WEBP_BASE64, "base64");

export const mediaRoutes: FastifyPluginAsync = async app => {
  const { uploadService, queryService, readService, actionsService, indexService, deleteService } = app.mediaServices;
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
        autoTagOnUpload: z.boolean().optional(),
      })
      .parse(req.body);

    assertUploadWithinLimit(body);

    const autoTagOnUpload = body.autoTagOnUpload !== undefined
      ? body.autoTagOnUpload
      : (await app.preferencesService.getPreferences(req.userId!).catch(() => null))?.autoTagOnUpload ?? true;
    const result = await uploadService.initUpload(req.userId!, { ...body, tags: parseTags(body.tags), autoTagOnUpload });
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
              autoTagOnUpload: z.boolean().optional(),
            }),
          )
          .min(1)
          .max(MAX_BATCH_ITEMS),
      })
      .parse(req.body);

    body.items.forEach(assertUploadWithinLimit);

    const prefs = body.items.some(i => i.autoTagOnUpload === undefined)
      ? await app.preferencesService.getPreferences(req.userId!).catch(() => null)
      : null;
    const autoTagDefault = prefs?.autoTagOnUpload ?? true;
    const items = body.items.map(item => ({
      ...item,
      tags: parseTags(item.tags),
      autoTagOnUpload: item.autoTagOnUpload !== undefined ? item.autoTagOnUpload : autoTagDefault,
    }));

    const result = await uploadService.initBatchUploads(req.userId!, items);
    req.log.info({ count: body.items.length }, "batch upload init");
    return result;
  });

  // POST /media/batch-finalize - mark uploads ready + enqueue processing
  app.post("/batch-finalize", { preHandler: [requireAuth] }, async req => {
    const body = z
      .object({
        ids: z.array(z.string().uuid()).min(1).max(MAX_BATCH_ITEMS),
        autoUnpack: z.boolean().optional(),
      })
      .parse(req.body);

    const userId = req.userId!;
    const result = await uploadService.finalizeBatch(userId, body.ids);
    req.log.info({ count: body.ids.length }, "batch upload finalized");

    // Auto-unpack archives if the user preference is enabled
    const autoUnpack = body.autoUnpack !== undefined
      ? body.autoUnpack
      : (await app.preferencesService.getPreferences(userId).catch(() => null))?.autoUnpackArchives ?? false;
    await autoUnpackIfEnabled(body.ids, userId, autoUnpack, getUnpackQueue, app.prisma, req.log);

    return result;
  });

  // POST /media/:id/finalize - mark upload ready + enqueue processing
  app.post<{ Params: { id: string } }>(
    "/:id/finalize",
    { preHandler: [requireAuth] },
    async req => {
      const userId = req.userId!;
      const { id } = paramsSchema.parse(req.params);
      const body = z.object({ autoUnpack: z.boolean().optional() }).parse(req.body ?? {});

      const result = await uploadService.finalizeBatch(userId, [id]);
      req.log.info({ mediaId: id }, "upload finalized");

      // Auto-unpack if archive and preference enabled
      const autoUnpack = body.autoUnpack !== undefined
        ? body.autoUnpack
        : (await app.preferencesService.getPreferences(userId).catch(() => null))?.autoUnpackArchives ?? false;
      await autoUnpackIfEnabled([id], userId, autoUnpack, getUnpackQueue, app.prisma, req.log);

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
      thumbState: z.enum(["PENDING", "READY", "ERROR", "FAILED", "UNSUPPORTED"]).optional(),
      textState: z.enum(["PENDING", "READY", "ERROR", "FAILED", "UNSUPPORTED"]).optional(),
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


  // GET /media/storage - data for the storage treemap. Returns the largest
  // files exactly plus a stratified, byte-weighted sample of the long tail so
  // the payload/DOM stay small at tens of thousands of files. top/sample are
  // tunable via query for experimentation.
  const StorageQuery = z.object({
    top:    z.coerce.number().int().min(1).max(2000).optional(),
    sample: z.coerce.number().int().min(0).max(2000).optional(),
  });
  app.get("/storage", { preHandler: [requireAuth] }, async req => {
    const userId = req.userId!;
    const { top, sample } = StorageQuery.parse(req.query);
    const { tiles, totalFiles, totalBytes } = await queryService.listAllSizes(userId, {
      topN: top,
      sampleN: sample,
    });
    return { items: tiles, totalFiles, totalBytes };
  });


  // GET /media/stats - aggregate doc count / storage / type breakdown (overview)
  app.get("/stats", { preHandler: [requireAuth] }, async req => {
    return queryService.getStats(req.userId!);
  });


  // GET /media/storage/categories - per-file-type storage totals (count + bytes)
  // for the overview "storage by type" graph.
  app.get("/storage/categories", { preHandler: [requireAuth] }, async req => {
    return queryService.getCategoryBreakdown(req.userId!);
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

  // POST /media/abort - dev escape hatch: hard-stop all background processing by
  // obliterating the index/thumb/ocr/unpack queues (clears the enqueue backlog
  // and any in-flight index walk that a restart alone won't stop).
  app.post("/abort", { preHandler: [requireAuth] }, async (req, reply) => {
    const userId = req.userId!;
    const result = await actionsService.abortProcessing();
    req.log.warn({ userId, cleared: result.cleared }, "processing queues aborted (dev)");
    return reply.send(result);
  });

  // DELETE /media - enqueue a background bulk delete and return 202 immediately.
  // The actual set-based delete + thumbnail unlinks run in the delete worker, so a
  // huge selection never blocks the request or starves the Prisma pool.
  //   - body { ids: [...] }  → delete those hand-picked items (multi-select).
  //   - filter query params  → delete everything matching (same format as GET /media);
  //                            an empty filter deletes every item the user owns.
  app.delete("/", { preHandler: [requireAuth] }, async (req, reply) => {
    const userId = req.userId!;

    const Body = z.object({ ids: z.array(z.string().min(1)).optional() }).optional();
    const ids = Body.parse(req.body ?? undefined)?.ids;

    if (ids && ids.length > 0) {
      const { jobId } = await deleteService.startDelete(userId, { ids });
      req.log.info({ userId, jobId, idCount: ids.length }, "bulk delete enqueued (ids)");
      return reply.code(202).send({ jobId });
    }

    const Query = z.object({
      q: z.string().trim().optional(),
      tags: z.unknown().optional(),
      excludeTags: z.string().trim().optional(),
      thumbState: z.enum(["PENDING", "READY", "ERROR", "FAILED", "UNSUPPORTED"]).optional(),
      textState: z.enum(["PENDING", "READY", "ERROR", "FAILED", "UNSUPPORTED"]).optional(),
      excludeUnpacked: z.coerce.boolean().optional(),
    });
    const { q, tags, excludeTags: excludeTagsRaw, thumbState, textState, excludeUnpacked } = Query.parse(req.query as Record<string, unknown>);

    const tagFilters = typeof tags === "string" ? tags.split(",").map(t => t.trim().toLowerCase()).filter(Boolean) : [];
    const excludeTagFilters = excludeTagsRaw ? excludeTagsRaw.split(",").map(t => t.trim().toLowerCase()).filter(Boolean) : [];

    const { jobId } = await deleteService.startDelete(userId, {
      filters: {
        queryText: q,
        tags: tagFilters,
        excludeTags: excludeTagFilters,
        thumbState,
        textState,
        excludeUnpacked,
      },
    });
    req.log.info({ userId, jobId }, "bulk delete enqueued (filter)");
    return reply.code(202).send({ jobId });
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

      const prefs = await app.preferencesService.getPreferences(userId).catch(() => null);
      const allowedRoots = prefs?.indexAllowedRoots ?? [];

      reply.raw.setHeader("Content-Type", "application/zip");
      reply.raw.setHeader("Content-Disposition", 'attachment; filename="vault-download.zip"');
      reply.hijack();

      await actionsService.streamBulkArchive(items, reply.raw, req.log, allowedRoots);
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

  // GET /media/:id/source - stream an in-place indexed original from disk.
  // Managed items have no source here (they use the presigned /download URL).
  app.get<{ Params: { id: string } }>(
    "/:id/source",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const userId = req.userId!;
      const { id } = paramsSchema.parse(req.params);

      const prefs = await app.preferencesService.getPreferences(userId).catch(() => null);
      const allowedRoots = prefs?.indexAllowedRoots ?? [];
      const result = await readService.getSourceStream(userId, id, allowedRoots);
      if (!result) return reply.notFound();

      if (result.contentLength != null) reply.header("content-length", String(result.contentLength));
      reply.type(result.mimeType);
      reply.header(
        "content-disposition",
        `inline; filename="${result.filename.replace(/["\\]/g, "_")}"`,
      );
      reply.header("cache-control", "private, max-age=3600");
      return reply.send(result.body);
    },
  );

  // GET /media/index/roots - configured in-place indexing roots (empty = disabled)
  app.get("/index/roots", { preHandler: [requireAuth] }, async (req) => {
    const userId = req.userId!;
    const prefs = await app.preferencesService.getPreferences(userId).catch(() => null);
    const roots = prefs?.indexAllowedRoots ?? [];
    return { enabled: roots.length > 0, roots };
  });

  // POST /media/index - scan a server-side folder and index its files in place
  app.post("/index", { preHandler: [requireAuth] }, async (req, reply) => {
    const userId = req.userId!;
    const body = z
      .object({
        path: z.string().min(1),
        recursive: z.boolean().optional(),
      })
      .parse(req.body);

    const prefs = await app.preferencesService.getPreferences(userId).catch(() => null);
    const allowedRoots = prefs?.indexAllowedRoots ?? [];
    const ignoreHidden = prefs?.ignoreHiddenFiles ?? true;
    const blacklistExtensions = prefs?.indexBlacklistExtensions ?? [];
    const excludeFolders = prefs?.indexExcludeFolders ?? [];
    const skipNonContent = prefs?.indexSkipNonContent ?? true;

    const result = await indexService.startIndex(userId, {
      path: body.path,
      recursive: body.recursive ?? true,
      ignoreHidden,
      blacklistExtensions,
      excludeFolders,
      skipNonContent,
    }, allowedRoots);

    if (!result.ok) {
      switch (result.reason) {
        case "disabled":
          return reply.badRequest("In-place indexing is disabled — add at least one allowed folder in Settings.");
        case "not_allowed":
          return reply.forbidden("That folder is not within an allowed indexing root.");
        case "not_found":
          return reply.notFound("Folder not found.");
        case "not_dir":
          return reply.badRequest("That path is not a directory.");
      }
    }

    req.log.info({ userId, path: body.path, jobId: result.jobId }, "index scan requested");
    return reply.send({ jobId: result.jobId });
  });

  // GET /media/index/status?jobId=... - poll scan progress
  app.get("/index/status", { preHandler: [requireAuth] }, async (req, reply) => {
    const userId = req.userId!;
    const { jobId } = z.object({ jobId: z.string().min(1) }).parse(req.query);

    const status = await indexService.getStatus(userId, jobId);
    if (!status) return reply.notFound();
    return reply.send(status);
  });

  // GET /media/index/active - the user's in-flight scan, so the UI can re-attach
  // after a reload. Returns { status: null } when nothing is running.
  app.get("/index/active", { preHandler: [requireAuth] }, async req => {
    const status = await indexService.getActive(req.userId!);
    return { status };
  });

  // POST /media/index/stop - stop the index walker without touching the worker
  // queues. Already-discovered files keep processing (thumbnails, OCR); only
  // the directory walk stops adding new files.
  app.post("/index/stop", { preHandler: [requireAuth] }, async (req, reply) => {
    req.log.info({ userId: req.userId }, "index walk stop requested");
    await actionsService.stopIndexWalk();
    return reply.send({ ok: true });
  });

  // GET /media/delete/status?jobId=... - poll bulk-delete progress
  app.get("/delete/status", { preHandler: [requireAuth] }, async (req, reply) => {
    const userId = req.userId!;
    const { jobId } = z.object({ jobId: z.string().min(1) }).parse(req.query);

    const status = await deleteService.getStatus(userId, jobId);
    if (!status) return reply.notFound();
    return reply.send(status);
  });

  // GET /media/delete/active - the user's in-flight bulk delete, so the UI can
  // re-attach after a reload. Returns { status: null } when nothing is running.
  app.get("/delete/active", { preHandler: [requireAuth] }, async req => {
    const status = await deleteService.getActive(req.userId!);
    return { status };
  });

  // POST /media/delete/abort - stop in-flight bulk deletes (epoch bump).
  app.post("/delete/abort", { preHandler: [requireAuth] }, async (req, reply) => {
    const userId = req.userId!;
    const result = await deleteService.abort();
    req.log.warn({ userId, ...result }, "bulk delete aborted");
    return reply.send(result ?? { epoch: null });
  });

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

      // Snapshot the allow-list so the worker can re-validate an in-place
      // source path (mirrors the index + thumbnail flows; env-based roots are
      // empty now that the list lives in user preferences).
      const prefs = await app.preferencesService.getPreferences(userId).catch(() => null);
      const allowedRoots = prefs?.indexAllowedRoots ?? [];

      const result = await actionsService.enqueueTextExtraction(userId, id, {
        language: body.language,
        rotation: body.rotation,
        forceOcr: body.forceOcr ?? false,
      }, allowedRoots);

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

      const result = await actionsService.unpackArchive(userId, id);

      if (!result) return reply.notFound();
      if (result === "not-archive") {
        return reply.badRequest("File is not a recognised archive type.");
      }
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

    const detail = await readService.getMediaDetail(userId, id);
    if (!detail) return reply.notFound();

    // Viewing an item is a strong signal it matters: bump its still-pending
    // thumbnail ahead of any backlog (e.g. after indexing a folder). Fire and
    // forget — a queue hiccup must never block serving the detail page.
    if (detail.media.thumbState === "PENDING") {
      void actionsService.prioritizeThumbnail(id).catch(err => {
        req.log.warn({ err, mediaId: id }, "[media] thumbnail prioritization failed");
      });
    }

    // Compute the local filesystem path for "Open in File Explorer".
    // In-place indexed items have sourcePath; fs-stored uploads live at
    // STORAGE_FS_PATH/storageKey. S3 items have no local path.
    let localPath: string | null = null;
    if (detail.media.sourcePath) {
      localPath = detail.media.sourcePath;
    } else if (app.config.STORAGE_DRIVER === "fs") {
      localPath = path.join(app.config.STORAGE_FS_PATH, detail.media.storageKey);
    }

    return reply.send({ ...detail, localPath });
  });

  // POST /media/:id/reveal - open the file in the OS file manager.
  // Works for in-place indexed items (sourcePath) and fs-stored uploads
  // (STORAGE_FS_PATH + storageKey). S3 items have no local path to open.
  app.post<{ Params: { id: string } }>(
    "/:id/reveal",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const userId = req.userId!;
      const { id } = paramsSchema.parse(req.params);

      // Refuse on deployments where the server can't reach the user's desktop
      // (remote/container/multi-user). The UI hides the button in this case too.
      if (!app.config.LOCAL_EXPLORER) {
        return reply.forbidden("File Explorer reveal is disabled on this server.");
      }

      const media = await app.prisma.media.findFirst({
        where: { id, userId },
        select: { sourcePath: true, storageKey: true },
      });
      if (!media) return reply.notFound();

      let revealPath: string;
      if (media.sourcePath) {
        // In-place indexed: re-validate against current allow-list.
        const prefs = await app.preferencesService.getPreferences(userId).catch(() => null);
        const allowedRoots = prefs?.indexAllowedRoots ?? [];
        if (!isUnderAllowedRoot(media.sourcePath, allowedRoots)) {
          return reply.forbidden("Source path is no longer within an allowed root.");
        }
        revealPath = media.sourcePath;
      } else if (app.config.STORAGE_DRIVER === "fs") {
        // Vault-managed filesystem upload: construct the storage path.
        revealPath = path.join(app.config.STORAGE_FS_PATH, media.storageKey);
      } else {
        return reply.badRequest("File is stored in S3 and has no local path.");
      }

      // Fail loudly if the file is gone — otherwise Explorer silently falls back
      // to opening the default folder, which looks like the wrong file opened.
      try {
        await stat(revealPath);
      } catch {
        return reply.notFound("File no longer exists at its recorded location.");
      }

      revealInExplorer(revealPath, req.log);
      return reply.send({ ok: true });
    },
  );

  // POST /media/:id/thumbnail/regenerate - force-requeue thumbnail generation
  app.post<{ Params: { id: string } }>(
    "/:id/thumbnail/regenerate",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const userId = req.userId!;
      const { id } = paramsSchema.parse(req.params);

      // Snapshot the allow-list so the worker can re-validate an in-place
      // source path (mirrors the index flow; env-based roots are empty now).
      const prefs = await app.preferencesService.getPreferences(userId).catch(() => null);
      const allowedRoots = prefs?.indexAllowedRoots ?? [];

      const result = await actionsService.regenerateThumbnail(userId, id, allowedRoots);
      if (!result) return reply.notFound();

      return reply.send(result);
    },
  );

  // Batch re-queue: collection-level paths kept distinct from the /:id/* routes
  // so Fastify doesn't treat "batch" as an :id. Both take { ids: string[] }.
  const batchBodySchema = z.object({ ids: z.array(z.string().min(1)).min(1).max(500) });

  const parseBatchBody = (body: unknown): string[] => {
    const parsed = batchBodySchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw app.httpErrors.badRequest(parsed.error.errors[0]?.message ?? "Invalid request body");
    }
    return parsed.data.ids;
  };

  // POST /media/batch/thumbnail - re-queue thumbnail generation for many items
  app.post("/batch/thumbnail", { preHandler: [requireAuth] }, async (req, reply) => {
    const userId = req.userId!;
    const ids = parseBatchBody(req.body);

    // Snapshot the allow-list once for the whole batch (see single-item route).
    const prefs = await app.preferencesService.getPreferences(userId).catch(() => null);
    const allowedRoots = prefs?.indexAllowedRoots ?? [];

    const result = await actionsService.regenerateThumbnailsBatch(userId, ids, allowedRoots);
    return reply.send(result);
  });

  // POST /media/batch/text - re-run text extraction for many items
  app.post("/batch/text", { preHandler: [requireAuth] }, async (req, reply) => {
    const userId = req.userId!;
    const ids = parseBatchBody(req.body);

    const prefs = await app.preferencesService.getPreferences(userId).catch(() => null);
    const allowedRoots = prefs?.indexAllowedRoots ?? [];

    const result = await actionsService.enqueueTextExtractionBatch(userId, ids, allowedRoots);
    return reply.send(result);
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
