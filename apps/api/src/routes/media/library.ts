/**
 * Serves the library listing and the summary figures shown around it.
 */
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireAuth } from "../../utils/authGuard.js";
import { MEDIA_SORT_OPTIONS } from "../../services/media/mediaQueryService.js";
import { MEDIA_SEARCH } from "../../lib/http/rateLimits.js";

const SORT_OPTIONS = MEDIA_SORT_OPTIONS;

export const mediaLibraryRoutes: FastifyPluginAsync = async app => {
  const { queryService } = app.mediaServices;

  // The main listing. Every filter is optional, and results are paged with a
  // cursor rather than an offset.
  app.get("/", { preHandler: [requireAuth, app.userRateLimit("media-search", MEDIA_SEARCH)] }, async req => {
    const userId = req.userId!;
    const rawQuery = req.query as Record<string, unknown>;
    const Query = z.object({
      q: z.string().trim().optional(),
      search: z.string().trim().optional(),
      tag: z.string().trim().optional(),
      tags: z.unknown().optional(),
      excludeTags: z.string().trim().optional(),
      thumbState: z.enum(["PENDING", "READY", "ERROR", "FAILED", "UNSUPPORTED"]).optional(),
      textState: z.enum(["PENDING", "READY", "ERROR", "FAILED", "UNSUPPORTED", "NEEDS_OCR"]).optional(),
      mimeType: z.string().trim().optional(),
      sort: z.enum(SORT_OPTIONS).optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
      cursor: z.string().optional(),
      excludeUnpacked: z.coerce.boolean().optional(),
      // Only value is "only" — the library's "Missing files" view. Omitting it
      // keeps missing items in the normal listing (flagged, not hidden).
      missing: z.literal("only").optional(),
    });
    const { q, search, tag, tags, excludeTags: excludeTagsRaw, thumbState, textState, mimeType, sort, limit, cursor, excludeUnpacked, missing } = Query.parse(
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
      missing,
      sort,
      limit,
      cursor,
    });
  });

  // Data for the storage map. The largest files are returned in full, and the
  // remainder as a sample weighted by size, so a library of tens of thousands
  // of files still renders.
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


  // Totals for the overview screen.
  app.get("/stats", { preHandler: [requireAuth] }, async req => {
    return queryService.getStats(req.userId!);
  });


  // Count and total size per file type, for the overview screen's storage graph.
  app.get("/storage/categories", { preHandler: [requireAuth] }, async req => {
    return queryService.getCategoryBreakdown(req.userId!);
  });

  // How many scanned documents are waiting to have their text read out.
  app.get("/text/scanned/count", { preHandler: [requireAuth] }, async req => {
    return { count: await queryService.countScannedAwaitingOcr(req.userId!) };
  });
};
