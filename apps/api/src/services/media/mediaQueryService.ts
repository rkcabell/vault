import crypto from "node:crypto";
import type IORedis from "ioredis";
import type { MediaRepository, MediaListFilters } from "../../repositories/mediaRepository.js";
import { buildStorageTreemap, type BuildTreemapOpts } from "../../lib/media/storageTreemap.js";
import { buildCategoryBreakdown } from "../../lib/media/categoryBreakdown.js";

/**
 * Reads the library for the browse and overview screens: paged listings, tag
 * counts, and the storage breakdowns. Every read here is filtered to one user.
 */

const SORT_OPTIONS = [
  "createdAt_desc",
  "createdAt_asc",
  "title_asc",
  "title_desc",
  "size_desc",
  "size_asc",
  "mimeType_asc",
  "starred_first",
  "fileDate_desc",
] as const;

export const MEDIA_SORT_OPTIONS = SORT_OPTIONS;

type ListMediaInput = {
  queryText?: string | null;
  tags?: string[];
  excludeTags?: string[];
  thumbState?: "PENDING" | "READY" | "ERROR" | "FAILED" | "UNSUPPORTED";
  /** NEEDS_OCR backs the library's "Scanned — text not extracted" filter. */
  textState?: "PENDING" | "READY" | "ERROR" | "FAILED" | "UNSUPPORTED" | "NEEDS_OCR";
  mimeTypePrefix?: string;
  excludeUnpacked?: boolean;
  /** "only" narrows to items whose source file is missing. */
  missing?: "only";
  sort?: typeof SORT_OPTIONS[number];
  limit?: number;
  cursor?: string | null;
};

function buildOrderBy (sort?: typeof SORT_OPTIONS[number]) {
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
    case "starred_first":
      // Every level shares one direction, so the raw path can keyset-paginate
      // with a single row-value comparison (mediaRepository._listMediaRaw).
      return [{ starred: "desc" as const }, { createdAt: "desc" as const }, { id: "desc" as const }];
    case "fileDate_desc":
      // The date carried by the file itself: EXIF, PDF metadata, or the file's
      // modified time. It is nullable, and the repository sorts these last
      // through the raw keyset path.
      return [{ fileDate: "desc" as const }, { id: "desc" as const }];
    default:
      return [{ createdAt: "desc" as const }, { id: "desc" as const }];
  }
}

/** Applies to first-page results only. Later pages are never cached. */
const SEARCH_CACHE_TTL_SECONDS = 10;

async function fetchPage (repository: MediaRepository, userId: string, listFilters: MediaListFilters, take: number) {
  const isFirstPage = listFilters.cursor === null;
  const [items, totalCount, hasExtractedItems] = await Promise.all([
    repository.listMedia(listFilters),
    isFirstPage ? repository.countMedia({ ...listFilters, cursor: null }) : Promise.resolve(undefined),
    isFirstPage ? repository.hasExtractedItems(userId) : Promise.resolve(undefined),
  ]);
  const hasMore = items.length > take;
  const sliced = hasMore ? items.slice(0, take) : items;
  const nextCursor = hasMore ? sliced[sliced.length - 1]?.id ?? null : null;
  return { items: sliced, nextCursor, totalCount, hasExtractedItems };
}

type MediaQueryDeps = {
  repository: MediaRepository;
  redis?: IORedis;
};

function searchCacheKey (userId: string, query: ListMediaInput): string {
  const payload = JSON.stringify({ userId, ...query });
  return `search:${userId}:${crypto.createHash("sha256").update(payload).digest("hex").slice(0, 16)}`;
}

export function createMediaQueryService (deps: MediaQueryDeps) {
  const listMedia = async (userId: string, query: ListMediaInput) => {
    const take = query.limit ?? 24;
    const orderBy = buildOrderBy(query.sort);

    const listFilters: MediaListFilters = {
      userId,
      queryText: query.queryText,
      tags: query.tags,
      excludeTags: query.excludeTags,
      thumbState: query.thumbState,
      textState: query.textState,
      mimeTypePrefix: query.mimeTypePrefix,
      excludeUnpacked: query.excludeUnpacked,
      missing: query.missing,
      orderBy,
      take: take + 1,
      cursor: query.cursor ?? null,
    };

    const isFirstPage = !query.cursor;

    // Later pages read through a keyset cursor and change with every click, so
    // only the first page is worth caching.
    if (isFirstPage && deps.redis) {
      const cacheKey = searchCacheKey(userId, query);
      const cached = await deps.redis.get(cacheKey).catch(() => null);
      if (cached) {
        try {
          return JSON.parse(cached) as Awaited<ReturnType<typeof fetchPage>>;
        } catch {
          // A corrupted entry falls through to the database.
        }
      }
      const result = await fetchPage(deps.repository, userId, listFilters, take);
      await deps.redis.setex(cacheKey, SEARCH_CACHE_TTL_SECONDS, JSON.stringify(result)).catch(() => {});
      return result;
    }

    return fetchPage(deps.repository, userId, listFilters, take);
  };

  const listTopTags = async (userId: string, limit: number) => {
    return deps.repository.listTopTags(userId, limit);
  };

  /** Returns the tiles for the storage treemap: the largest files, plus a
   *  byte-weighted sample of the rest. The set is bounded, not one tile per file. */
  const listAllSizes = async (userId: string, opts?: BuildTreemapOpts) => {
    const rows = await deps.repository.listAllMediaSizes(userId);
    return buildStorageTreemap(rows, opts);
  };

  /** Returns the library's item count, storage used, and type breakdown. */
  const getStats = async (userId: string) => {
    return deps.repository.getMediaStats(userId);
  };

  /** Returns storage totals per file category, over the whole library.
   *  Categories are read from the filename, matching the treemap. */
  const getCategoryBreakdown = async (userId: string) => {
    const rows = await deps.repository.listAllMediaSizes(userId);
    return buildCategoryBreakdown(rows);
  };

  /** Returns how many items are waiting for OCR. This is the set behind the
   *  library's "Scanned — text not extracted" filter. */
  const countScannedAwaitingOcr = (userId: string) => deps.repository.countNeedsOcr(userId);

  return { listMedia, listTopTags, listAllSizes, getStats, getCategoryBreakdown, countScannedAwaitingOcr };
}
