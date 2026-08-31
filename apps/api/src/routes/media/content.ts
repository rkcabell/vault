/**
 * Serves file bytes to the browser: downloads, in-place originals, and
 * thumbnails.
 */
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireAuth } from "../../utils/authGuard.js";
import { parseRangeHeader } from "../../lib/http/range.js";
import { BULK_DOWNLOAD } from "../../lib/http/rateLimits.js";
import { paramsSchema } from "./shared.js";

// A one-pixel image, sent in place of a thumbnail that cannot be produced, so
// the library grid shows something rather than a broken image.
const FALLBACK_WEBP_BASE64 =
  "UklGRiwAAABXRUJQVlA4ICAAAABwAQCdASoBAAEAAUAmJZQCdAFAAAD++QRjZQJ+NXuAAA==";
const FALLBACK_WEBP = Buffer.from(FALLBACK_WEBP_BASE64, "base64");

/**
 * The routes that write to the socket themselves rather than returning a body.
 *
 * Each one takes over the response, handles byte ranges, or sets its own cache
 * headers, which is what separates them from the other media routes.
 */
export const mediaContentRoutes: FastifyPluginAsync = async app => {
  const { readService, actionsService, archiveService } = app.mediaServices;

  // Streams the chosen items as a zip while it is being built, so nothing is
  // held in memory or written to a temporary file.
  app.post(
    "/bulk-download",
    { preHandler: [requireAuth, app.userRateLimit("bulk-download", BULK_DOWNLOAD)] },
    async (req, reply) => {
      const userId = req.userId!;
      const body = z
        .object({ ids: z.array(z.string().uuid()).min(1).max(50) })
        .parse(req.body);

      const items = await archiveService.getBulkDownloadItems(userId, body.ids);

      if (items.length === 0) return reply.notFound();

      const prefs = await app.preferencesService.getPreferences(userId).catch(() => null);
      const allowedRoots = prefs?.indexAllowedRoots ?? [];

      reply.raw.setHeader("Content-Type", "application/zip");
      reply.raw.setHeader("Content-Disposition", 'attachment; filename="vault-download.zip"');
      reply.hijack();

      await archiveService.streamBulkArchive(items, reply.raw, req.log, allowedRoots);
    },
  );

  // Returns a URL the browser can fetch the file from, rather than the bytes.
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

  // Streams a file that was indexed where it sits on disk. An item held in
  // Vault's own storage has no source here and is fetched through the download
  // URL instead.
  app.get<{ Params: { id: string } }>(
    "/:id/source",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const userId = req.userId!;
      const { id } = paramsSchema.parse(req.params);

      const prefs = await app.preferencesService.getPreferences(userId).catch(() => null);
      const allowedRoots = prefs?.indexAllowedRoots ?? [];

      // The file is opened once without a range purely to learn its size, which
      // a range request has to be checked against. Opening is lazy, so closing
      // that stream unread costs nothing.
      let range: { start: number; end: number } | undefined;
      const probe = await readService.getSourceStream(userId, id, allowedRoots);
      if (!probe) return reply.notFound();

      reply.header("accept-ranges", "bytes");
      reply.type(probe.mimeType);
      reply.header(
        "content-disposition",
        `inline; filename="${probe.filename.replace(/["\\]/g, "_")}"`,
      );
      reply.header("cache-control", "private, max-age=3600");

      const size = probe.totalLength;
      if (req.headers.range && size != null) {
        const parsed = parseRangeHeader(req.headers.range, size);
        if (parsed === "unsatisfiable") {
          probe.body.destroy();
          reply.header("content-range", `bytes */${size}`);
          return reply.code(416).send();
        }
        if (parsed) range = parsed;
      }

      if (range) {
        probe.body.destroy();
        const result = await readService.getSourceStream(userId, id, allowedRoots, range);
        if (!result) return reply.notFound();
        reply.header("content-range", `bytes ${range.start}-${range.end}/${size}`);
        reply.header("content-length", String(range.end - range.start + 1));
        return reply.code(206).send(result.body);
      }

      if (probe.contentLength != null) reply.header("content-length", String(probe.contentLength));
      return reply.send(probe.body);
    },
  );

  // Sends a thumbnail, or the placeholder pixel when there is none. A
  // malformed id gets the placeholder too, rather than an error.
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
