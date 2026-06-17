import crypto from "node:crypto";
import type IORedis from "ioredis";
import type { MediaRepository, MediaListFilters } from "../../repositories/mediaRepository.js";

const SORT_OPTIONS = [
  "createdAt_desc",
  "createdAt_asc",
  "title_asc",
  "title_desc",
  "size_desc",
  "size_asc",
  "mimeType_asc",
] as const;

export const MEDIA_SORT_OPTIONS = SORT_OPTIONS;

type ListMediaInput = {
  queryText?: string | null;
  tags?: string[];
  excludeTags?: string[];
  thumbState?: "PENDING" | "READY" | "ERROR" | "FAILED";
  textState?: "PENDING" | "READY" | "ERROR" | "FAILED";
  mimeTypePrefix?: string;
  excludeUnpacked?: boolean;
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
    default:
      return [{ createdAt: "desc" as const }, { id: "desc" as const }];
  }
}

/** TTL for first-page search results. Short enough to feel live; long enough to absorb rapid pagination clicks. */
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
      orderBy,
      take: take + 1,
      cursor: query.cursor ?? null,
    };

    const isFirstPage = !query.cursor;

    // Cache first-page results in Redis to absorb repeated identical queries.
    // Paginated pages are cheap (keyset cursor) and vary per click, so not cached.
    if (isFirstPage && deps.redis) {
      const cacheKey = searchCacheKey(userId, query);
      const cached = await deps.redis.get(cacheKey).catch(() => null);
      if (cached) {
        try {
          return JSON.parse(cached) as Awaited<ReturnType<typeof fetchPage>>;
        } catch {
          // corrupted cache entry — fall through to DB
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

  /** Per-file sizes for the whole vault — powers the storage treemap. */
  const listAllSizes = async (userId: string) => {
    return deps.repository.listAllMediaSizes(userId);
  };

  /** Aggregate counts/storage/type breakdown for the overview header + viz. */
  const getStats = async (userId: string) => {
    return deps.repository.getMediaStats(userId);
  };

  return { listMedia, listTopTags, listAllSizes, getStats };
}
