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
  thumbState?: "PENDING" | "READY" | "ERROR" | "FAILED";
  textState?: "PENDING" | "READY" | "ERROR" | "FAILED";
  sort?: typeof SORT_OPTIONS[number];
  limit?: number;
  cursor?: string | null;
  page?: number | null;
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

type MediaQueryDeps = {
  repository: MediaRepository;
};

export function createMediaQueryService (deps: MediaQueryDeps) {
  const listMedia = async (userId: string, query: ListMediaInput) => {
    const take = query.limit ?? 24;
    const orderBy = buildOrderBy(query.sort);

    const listFilters: MediaListFilters = {
      userId,
      queryText: query.queryText,
      tags: query.tags,
      thumbState: query.thumbState,
      textState: query.textState,
      orderBy,
      take: take + 1,
      cursor: query.cursor ?? null,
    };

    if (!query.cursor && query.page) {
      listFilters.skip = (query.page - 1) * take;
    }

    const items = await deps.repository.listMedia(listFilters);

    const hasMore = items.length > take;
    const sliced = hasMore ? items.slice(0, take) : items;
    const nextCursor = hasMore ? sliced[sliced.length - 1]?.id ?? null : null;
    const nextPage = query.page && hasMore ? query.page + 1 : null;

    return { items: sliced, nextCursor, nextPage };
  };

  const listTopTags = async (userId: string, limit: number) => {
    return deps.repository.listTopTags(userId, limit);
  };

  return { listMedia, listTopTags };
}
