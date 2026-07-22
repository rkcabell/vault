import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { Readable } from "node:stream";
import { requireAuth } from "../utils/authGuard.js";
import { InvalidStorageKeyError } from "../adapters/storage/fsAdapter.js";
import { parseRangeHeader } from "../lib/http/range.js";

/**
 * Storage proxy routes — the transfer path for the filesystem backend.
 *
 * In `fs` mode the storage adapter's `presignPut` / `presignGet` return URLs
 * pointing here (there are no S3 presigned URLs for a plain filesystem), so the
 * browser uploads/downloads originals by streaming through these routes. In
 * `s3` mode the browser talks to MinIO directly and never hits these routes;
 * they remain registered but unused.
 *
 * Authorization: keys are namespaced by owner (`userId/mediaId/filename`), so a
 * request may only touch keys under its own `userId/` prefix — defense in depth
 * defense in depth across all deployments.
 */
export const storageRoutes: FastifyPluginAsync = async (app) => {
  // Treat every request body as a raw stream (no buffering, no bodyLimit), so
  // large uploads pass straight through to the storage backend. Encapsulated to
  // this plugin — does not affect JSON parsing elsewhere.
  app.addContentTypeParser("*", (_req, payload, done) => done(null, payload));

  const keyFromReq = (req: FastifyRequest): string =>
    (req.params as { "*"?: string })["*"] ?? "";

  // Map common extensions to a content type so the browser can render originals
  // inline (image/PDF preview), matching how S3/MinIO returns the stored type.
  // Unknown types fall back to octet-stream (browser downloads them).
  const EXT_CONTENT_TYPE: Record<string, string> = {
    pdf: "application/pdf",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    avif: "image/avif",
    bmp: "image/bmp",
    tiff: "image/tiff",
    heic: "image/heic",
    mp4: "video/mp4",
    webm: "video/webm",
    mov: "video/quicktime",
    txt: "text/plain; charset=utf-8",
    csv: "text/csv; charset=utf-8",
    html: "text/html; charset=utf-8",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    ogg: "audio/ogg",
  };

  const contentTypeForKey = (key: string): string => {
    const ext = key.split(".").pop()?.toLowerCase() ?? "";
    return EXT_CONTENT_TYPE[ext] ?? "application/octet-stream";
  };

  /** Ensure the key belongs to the authenticated user. Returns false (and replies) if not. */
  const authorizeKey = (req: FastifyRequest, reply: FastifyReply, key: string): boolean => {
    if (!key || key.split("/")[0] !== req.userId) {
      void reply.forbidden("You do not have access to this object");
      return false;
    }
    return true;
  };

  app.put("/blob/*", { preHandler: [requireAuth] }, async (req, reply) => {
    const key = keyFromReq(req);
    if (!authorizeKey(req, reply, key)) return;

    const contentType = req.headers["content-type"] ?? "application/octet-stream";
    const lengthHeader = req.headers["content-length"];
    const contentLength = lengthHeader ? Number(lengthHeader) : undefined;

    try {
      await app.storage.putObject({
        bucket: app.config.STORAGE_BUCKET,
        key,
        body: req.body as Readable,
        contentType,
        ...(contentLength !== undefined && Number.isFinite(contentLength) ? { contentLength } : {}),
      });
    } catch (err) {
      if (err instanceof InvalidStorageKeyError) return reply.badRequest("Invalid object key");
      throw err;
    }
    return reply.code(204).send();
  });

  app.get("/blob/*", { preHandler: [requireAuth] }, async (req, reply) => {
    const key = keyFromReq(req);
    if (!authorizeKey(req, reply, key)) return;

    let res;
    try {
      res = await app.storage.getObjectStream({ bucket: app.config.STORAGE_BUCKET, key });
    } catch (err) {
      if (err instanceof InvalidStorageKeyError) return reply.badRequest("Invalid object key");
      throw err;
    }
    if (!res) return reply.notFound();

    reply.header("accept-ranges", "bytes");
    reply.header("content-type", contentTypeForKey(key));
    reply.header("cache-control", "private, max-age=3600");

    // Honor single-range requests (video seeking, large-file partial reads).
    const size = res.totalLength ?? res.contentLength;
    const rangeHeader = req.headers.range;
    if (rangeHeader && size != null) {
      const range = parseRangeHeader(rangeHeader, size);
      if (range === "unsatisfiable") {
        res.body.destroy();
        reply.header("content-range", `bytes */${size}`);
        return reply.code(416).send();
      }
      if (range) {
        // The un-ranged stream is lazy (not yet opened) — swap it for a ranged one.
        res.body.destroy();
        const ranged = await app.storage.getObjectStream({ bucket: app.config.STORAGE_BUCKET, key, range });
        if (!ranged) return reply.notFound();
        reply.header("content-range", `bytes ${range.start}-${range.end}/${size}`);
        reply.header("content-length", String(range.end - range.start + 1));
        return reply.code(206).send(ranged.body);
      }
    }

    if (res.contentLength != null) reply.header("content-length", String(res.contentLength));
    return reply.send(res.body);
  });
};
