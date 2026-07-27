// File: apps/web/app/(protected)/library/LibraryPageInner.tsx
"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch } from "@/lib/apiFetch";
import { usePreferences } from "@/hooks/usePreferences";
import { useRouter, useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";

const DevPurgeButton =
  process.env.NODE_ENV === "development"
    ? dynamic(() => import("@/components/dev/DevPurgeButton"))
    : null;
import { Container, PageHeader } from "@/components/common";
import { MediaCard, MediaCardListHeader, MediaCardSkeleton, LibraryUpdateBanner, type MediaItem } from "@/components/media";
import { BulkActionBar } from "@/components/media/BulkActionBar";
import { BulkTagDialog } from "@/components/media/BulkTagDialog";
import { BulkBundleDialog } from "@/components/media/BulkBundleDialog";
import { TagFilterChip, type TagFilterState } from "@/components/media/TagFilterChip";
import { Button } from "@/components/ui/Button";
import { ConfirmPopover } from "@/components/ui/ConfirmPopover";
import { Plus, LayoutGrid, LayoutList, Upload, ChevronDown, Search, X, Tag } from "lucide-react";
import { useUpload } from "@/components/contexts/UploadContext";
import { useDeleteProgress } from "@/components/contexts/DeleteProgressContext";
import { regenerateThumbnailsBatch, extractTextBatch } from "@/lib/media/batch";
import { emitTagsUpdated, TAGS_UPDATED_EVENT, partitionTagsByOrigin } from "@/lib/tags";
import type { TagOrigin } from "@vault/types";
import { BUNDLES_UPDATED_EVENT, emitBundlesUpdated } from "@/lib/bundles";
import { MEDIA_LIST_UPDATED_EVENT, type MediaListUpdatedDetail } from "@/lib/media/events";
import { useMediaEvents } from "@/hooks/useMediaEvents";
import { useInfiniteScroll } from "@/hooks/useInfiniteScroll";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/DropdownMenu";

// Thumbnail loading behavior.
const EAGER_THUMB_COUNT = 6;
// Items loaded per "page" — grid sizes are row-based so each load fills complete rows.
const LIST_ITEMS_PER_LOAD = 24;
const GRID_ROWS_PER_LOAD = 5;          // comfortable grid: 5 full rows
const COMPACT_GRID_ROWS_PER_LOAD = 10; // compact grid: 10 full rows (≈50 at default 5 cols)
// Grid density settings. 7+ triggers compact card style (no tags, no action button).
const DENSITY_OPTIONS = [4, 5, 6, 7, 8] as const;
// Sort menu definitions.
const SORT_OPTIONS = [
  { value: "createdAt_desc", label: "Newest" },
  { value: "createdAt_asc", label: "Oldest" },
  { value: "title_asc", label: "Name A-Z" },
  { value: "title_desc", label: "Name Z-A" },
  { value: "size_desc", label: "Largest" },
  { value: "size_asc", label: "Smallest" },
  { value: "mimeType_asc", label: "Type" },
  { value: "starred_first", label: "Starred first" },
  // Sorts by the file's own date (EXIF/PDF/mtime, not upload time) and lays
  // the library out with year + month section breaks.
  { value: "fileDate_desc", label: "Year" },
] as const;

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

type SortValue = (typeof SORT_OPTIONS)[number]["value"];
type DensityValue = (typeof DENSITY_OPTIONS)[number];

// Processing-status filter. Each option maps to the API's thumbState/textState
// query params (a single enum each). "Needs …" surfaces the un-queued PENDING
// items left behind after Abort Queues so they can be re-queued in bulk.
const STATUS_OPTIONS = [
  { value: "all", label: "All statuses", thumbState: "", textState: "", missing: "" },
  { value: "thumb_pending", label: "Pending thumbnail", thumbState: "PENDING", textState: "", missing: "" },
  { value: "thumb_error", label: "Thumbnail error", thumbState: "FAILED", textState: "", missing: "" },
  { value: "text_pending", label: "Pending text", thumbState: "", textState: "PENDING", missing: "" },
  { value: "text_error", label: "Text error", thumbState: "", textState: "ERROR", missing: "" },
  // Indexed items whose file is no longer on disk. Their rows are kept so a
  // move can reclaim them, which also means the user needs a way to see them.
  { value: "missing", label: "Missing files", thumbState: "", textState: "", missing: "only" },
] as const;

type StatusValue = (typeof STATUS_OPTIONS)[number]["value"];

// Default query param values.
const DEFAULT_SORT: SortValue = "createdAt_desc";
const LIBRARY_PATH = "/library";

type MediaListItem = {
  id: string;
  title: string;
  filename?: string | null;
  thumbState: MediaItem["thumbState"];
  textState: MediaItem["textState"];
  tags?: string[];
  mimeType?: string | null;
  sizeBytes?: number | null;
  starred?: boolean;
  createdAt: string;
  fileDate?: string | null;
  /** Set when the item's source file is no longer on disk. */
  missingSince?: string | null;
};

type MediaListResponse = {
  items: MediaListItem[];
  nextCursor?: string | null;
  totalCount?: number;
  hasExtractedItems?: boolean;
};


async function readErrorMessage(response: Response) {
  try {
    const data = await response.json();
    if (data?.error || data?.message) return data.error || data.message;
  } catch {
    // ignore
  }
  return `Failed to load media (${response.status})`;
}

function applyFilterParams(
  params: URLSearchParams,
  opts: {
    q: string;
    includedTagsList: string[];
    excludedTagsList: string[];
    thumbState: string;
    textState: string;
    missing: string;
    hideUnpackedItems: boolean;
  },
) {
  if (opts.q) params.set("q", opts.q);
  if (opts.includedTagsList.length > 0) params.set("tags", opts.includedTagsList.join(","));
  if (opts.excludedTagsList.length > 0) params.set("excludeTags", opts.excludedTagsList.join(","));
  if (opts.thumbState) params.set("thumbState", opts.thumbState);
  if (opts.textState) params.set("textState", opts.textState);
  if (opts.missing) params.set("missing", opts.missing);
  if (opts.hideUnpackedItems && !opts.q && opts.includedTagsList.length === 0) params.set("excludeUnpacked", "1");
}

export default function LibraryPageInner() {
  const router = useRouter();

  // Upload context.
  const { addFiles } = useUpload();

  // List fetch state.
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [mediaItems, setMediaItems] = useState<MediaItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [totalCount, setTotalCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Tag filter panel.
  const [showTagFilter, setShowTagFilter] = useState(false);
  const [tagOptions, setTagOptions] = useState<{ name: string; count: number; color: string | null; origin?: TagOrigin }[]>([]);
  const [tagSearch, setTagSearch] = useState('');
  const [hasUnpackedArchiveBundles, setHasUnpackedArchiveBundles] = useState(false);

  // Delete coordination.
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());
  const deletedIdsRef = useRef<Set<string>>(new Set());
  const fetchIdRef = useRef(0);
  // Background bulk delete (runs in the worker; this page tracks its progress).
  const { start: startBulkDeleteJob, status: bulkDeleteStatus } = useDeleteProgress();
  const reconciledDeleteJobRef = useRef<string | null>(null);

  // Select mode.
  const [isSelectMode, setIsSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isSelectAllLibrary, setIsSelectAllLibrary] = useState(false);
  const lastSelectedIdRef = useRef<string | null>(null);
  const [isTagDialogOpen, setIsTagDialogOpen] = useState(false);
  const [isBundleDialogOpen, setIsBundleDialogOpen] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [isRequeueing, setIsRequeueing] = useState(false);

  // Delete confirmation popover.
  const [confirmState, setConfirmState] = useState<{ x: number; y: number; anchorWidth?: number; bottomOffset?: number; topOffset?: number; message: string; action: () => void } | null>(null);

  // Refresh control.
  const [refreshToken, setRefreshToken] = useState(0);
  const [hasHandledRefreshParam, setHasHandledRefreshParam] = useState(false);

  // View + density controls.
  const { prefs, updatePreferences } = usePreferences();
  const viewMode = prefs.libraryViewMode;
  const gridCols = prefs.libraryGridCols;
  const isCompactList = prefs.libraryIsCompactList;
  const hideUnpackedItems = prefs.hideUnpackedItems;
  // Compact grid is derived: 7+ columns triggers compact card style.
  const isCompactGrid = gridCols >= 7;

  // Drag/drop overlay state (robust against child enter/leave flicker)
  const [isDragging, setIsDragging] = useState(false);
  const dragDepthRef = useRef(0);

  // Search and filter params.
  const searchParams = useSearchParams();
  const q = searchParams.get("q")?.trim() ?? "";

  // Local title search input — debounces into URL param.
  const [searchInput, setSearchInput] = useState(q);
  useEffect(() => { setSearchInput(q); }, [q]);
  useEffect(() => {
    const timer = setTimeout(() => {
      const params = new URLSearchParams(searchParams.toString());
      if (searchInput.trim()) params.set("q", searchInput.trim());
      else params.delete("q");
      const nextQuery = params.toString();
      router.push(nextQuery ? `${LIBRARY_PATH}?${nextQuery}` : LIBRARY_PATH);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]); // eslint-disable-line react-hooks/exhaustive-deps
  const tagsParam = searchParams.get("tags")?.trim() ?? "";
  const singleTag = searchParams.get("tag")?.trim() ?? "";
  const excludeTagsParam = searchParams.get("excludeTags")?.trim() ?? "";

  // All included tags (union of ?tags= and legacy ?tag=).
  const includedTagsList = useMemo(() => {
    const combined = [
      ...tagsParam.split(",").map(t => t.trim()).filter(Boolean),
      ...singleTag.split(",").map(t => t.trim()).filter(Boolean),
    ];
    return [...new Set(combined)];
  }, [tagsParam, singleTag]);

  // For backwards-compat with code that used a single `tag` string.
  const tag = includedTagsList[0] ?? "";

  const excludedTagsList = useMemo(
    () => excludeTagsParam.split(",").map(t => t.trim()).filter(Boolean),
    [excludeTagsParam],
  );

  // Ref kept in sync so stable event handlers always see fresh filter state.
  const tagFilterStateRef = useRef({ showTagFilter, includedTagsList, excludedTagsList, searchParams });
  useEffect(() => {
    tagFilterStateRef.current = { showTagFilter, includedTagsList, excludedTagsList, searchParams };
  });

  const thumbState = searchParams.get("thumbState")?.trim() ?? "";
  const textState = searchParams.get("textState")?.trim() ?? "";
  const missing = searchParams.get("missing")?.trim() ?? "";
  const sortParam = searchParams.get("sort")?.trim();
  const sort = SORT_OPTIONS.some((option) => option.value === sortParam)
    ? (sortParam as SortValue)
    : DEFAULT_SORT;
  const sortLabel =
    SORT_OPTIONS.find((option) => option.value === sort)?.label ?? "Newest";

  // Layout class helpers.
  const gridClassByCols: Record<4 | 5 | 6 | 7 | 8, string> = {
    4: "grid-cols-2 sm:grid-cols-3 md:grid-cols-4",
    5: "grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5",
    6: "grid-cols-2 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6",
    7: "grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-7",
    8: "grid-cols-4 sm:grid-cols-5 md:grid-cols-7 lg:grid-cols-8",
  };

  const layoutClass =
    viewMode === "grid"
      ? `grid items-start ${isCompactGrid ? "gap-1" : "gap-4"} ${gridClassByCols[gridCols]}`
      : isCompactList
      ? "space-y-0"
      : "space-y-4";

  const cardDensity: "compact" | "comfortable" =
    (viewMode === "grid" && isCompactGrid) || (viewMode === "list" && isCompactList)
      ? "compact"
      : "comfortable";

  // "Year" sort: group the ordered list into year → month sections. Adjacent
  // grouping is enough because the API returns items ordered by fileDate;
  // null dates sort last and collapse into a single "Unknown date" section.
  const isYearSort = sort === "fileDate_desc";
  // Year sections the user has collapsed, keyed by year key ("2024" / "unknown").
  const [collapsedYears, setCollapsedYears] = useState<Set<string>>(new Set());
  const toggleYearCollapsed = useCallback((key: string) => {
    setCollapsedYears(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const dateGroups = useMemo(() => {
    if (!isYearSort) return null;
    type MonthGroup = { key: string; label: string | null; entries: { media: MediaItem; index: number }[] };
    type YearGroup = { key: string; label: string; months: MonthGroup[] };
    const groups: YearGroup[] = [];
    mediaItems.forEach((media, index) => {
      const parsed = media.fileDate ? new Date(media.fileDate) : null;
      const d = parsed !== null && !Number.isNaN(parsed.getTime()) ? parsed : null;
      const yearKey = d ? String(d.getFullYear()) : "unknown";
      const monthKey = d ? `${yearKey}-${d.getMonth()}` : "unknown";
      let year = groups[groups.length - 1];
      if (!year || year.key !== yearKey) {
        year = { key: yearKey, label: d ? yearKey : "Unknown date", months: [] };
        groups.push(year);
      }
      let month = year.months[year.months.length - 1];
      if (!month || month.key !== monthKey) {
        month = { key: monthKey, label: d ? MONTH_NAMES[d.getMonth()] : null, entries: [] };
        year.months.push(month);
      }
      month.entries.push({ media, index });
    });
    return groups;
  }, [isYearSort, mediaItems]);

  const buildQuery = useCallback(
    (cursor?: string) => {
      const itemLimit =
        viewMode === "list"
          ? LIST_ITEMS_PER_LOAD
          : isCompactGrid
            ? COMPACT_GRID_ROWS_PER_LOAD * gridCols
            : GRID_ROWS_PER_LOAD * gridCols;
      const params = new URLSearchParams();
      params.set("limit", String(itemLimit));
      params.set("sort", sort);
      applyFilterParams(params, { q, includedTagsList, excludedTagsList, thumbState, textState, missing, hideUnpackedItems });
      if (cursor) params.set("cursor", cursor);
      return params.toString();
    },
    [excludedTagsList, gridCols, hideUnpackedItems, includedTagsList, isCompactGrid, missing, q, sort, textState, thumbState, viewMode]
  );

  const buildDeleteAllQuery = useCallback(() => {
    const params = new URLSearchParams();
    applyFilterParams(params, { q, includedTagsList, excludedTagsList, thumbState, textState, missing, hideUnpackedItems });
    return params.toString();
  }, [excludedTagsList, hideUnpackedItems, includedTagsList, missing, q, textState, thumbState]);

  const handleSortChange = useCallback(
    (value: SortValue) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value === DEFAULT_SORT) params.delete("sort");
      else params.set("sort", value);
      const nextQuery = params.toString();
      router.push(nextQuery ? `${LIBRARY_PATH}?${nextQuery}` : LIBRARY_PATH);
    },
    [router, searchParams],
  );

  const statusValue: StatusValue =
    STATUS_OPTIONS.find(
      (o) => o.thumbState === thumbState && o.textState === textState && o.missing === missing,
    )?.value ?? "all";
  const statusLabel = STATUS_OPTIONS.find((o) => o.value === statusValue)?.label ?? "All statuses";

  const handleStatusChange = useCallback(
    (value: StatusValue) => {
      const opt = STATUS_OPTIONS.find((o) => o.value === value);
      const params = new URLSearchParams(searchParams.toString());
      if (opt?.thumbState) params.set("thumbState", opt.thumbState);
      else params.delete("thumbState");
      if (opt?.textState) params.set("textState", opt.textState);
      else params.delete("textState");
      if (opt?.missing) params.set("missing", opt.missing);
      else params.delete("missing");
      const nextQuery = params.toString();
      router.push(nextQuery ? `${LIBRARY_PATH}?${nextQuery}` : LIBRARY_PATH);
    },
    [router, searchParams],
  );

  const clearAllFilters = useCallback(() => {
    setSearchInput("");
    const params = new URLSearchParams(searchParams.toString());
    params.delete("q");
    params.delete("tags");
    params.delete("tag");
    params.delete("excludeTags");
    const qs = params.toString();
    router.replace(qs ? `${LIBRARY_PATH}?${qs}` : LIBRARY_PATH);
  }, [router, searchParams]);

  const cycleTag = useCallback((tag: string) => {
    const isIncluded = includedTagsList.includes(tag);
    const isExcluded = excludedTagsList.includes(tag);
    const params = new URLSearchParams(searchParams.toString());

    let newIncluded = [...includedTagsList];
    let newExcluded = [...excludedTagsList];

    if (isIncluded) {
      newIncluded = newIncluded.filter(t => t !== tag);
      newExcluded = [...newExcluded, tag];
    } else if (isExcluded) {
      newExcluded = newExcluded.filter(t => t !== tag);
    } else {
      newIncluded = [...newIncluded, tag];
    }

    if (newIncluded.length > 0) params.set("tags", newIncluded.join(","));
    else { params.delete("tags"); params.delete("tag"); }

    if (newExcluded.length > 0) params.set("excludeTags", newExcluded.join(","));
    else params.delete("excludeTags");

    const nextQuery = params.toString();
    router.push(nextQuery ? `${LIBRARY_PATH}?${nextQuery}` : LIBRARY_PATH);
  }, [includedTagsList, excludedTagsList, searchParams, router]);

  const getTagFilterState = (tag: string): TagFilterState => {
    if (includedTagsList.includes(tag)) return "include";
    if (excludedTagsList.includes(tag)) return "exclude";
    return "unselected";
  };

  const filteredTagOptions = useMemo(() => {
    const q = tagSearch.trim().toLowerCase();
    const matched = q ? tagOptions.filter(t => t.name.toLowerCase().includes(q)) : tagOptions;
    // Keep user-made tags ahead of auto ones, preserving the count ranking within
    // each group.
    return partitionTagsByOrigin(matched, t => t.origin === 'AUTO');
  }, [tagOptions, tagSearch]);

  // True when any user-initiated filter is active. Used to keep the toolbar
  // visible even when the filtered result set is empty.
  const hasAnyFilter = !!(q || includedTagsList.length > 0 || excludedTagsList.length > 0 || thumbState || textState || missing);


  const hydrateItems = useCallback((list: MediaListItem[]) => {
    return list.map((item) => {
      return {
        id: item.id,
        title: item.title,
        filename: item.filename,
        thumbState: item.thumbState,
        textState: item.textState,
        tags: item.tags,
        mimeType: item.mimeType,
        sizeBytes: item.sizeBytes,
        starred: item.starred,
        fileDate: item.fileDate ?? null,
      } satisfies MediaItem;
    });
  }, []);

  const handleStarToggle = useCallback((id: string, next: boolean) => {
    setMediaItems(prev => prev.map(item => (item.id === id ? { ...item, starred: next } : item)));
  }, []);

  const fetchMedia = useCallback(
    async (opts?: { cursor?: string; append?: boolean; silent?: boolean }) => {
      const cursor = opts?.cursor;
      const append = opts?.append ?? false;
      const silent = opts?.silent ?? false;
      const requestId = ++fetchIdRef.current;

      if (!silent) {
        if (append) setIsLoadingMore(true);
        else setIsLoading(true);
      }

      if (process.env.NODE_ENV === "development") {
        console.debug("[library] list request", { cursor: cursor ?? null, append });
      }

      try {
        const res = await apiFetch(`/api/media?${buildQuery(cursor)}`, {
          method: "GET",
          credentials: "include",
        });

        if (requestId !== fetchIdRef.current) return;

        if (res.status === 401) {
          router.push("/auth");
          return;
        }

        if (!res.ok) {
          const msg = await readErrorMessage(res);
          if (requestId !== fetchIdRef.current) return;
          setError(msg);
          return;
        }

        const data = (await res.json()) as MediaListResponse;
        if (requestId !== fetchIdRef.current) return;
        const hydrated = hydrateItems(data.items ?? []);
        if (requestId !== fetchIdRef.current) return;

        // Merge + de-dupe + never resurrect locally deleted ids
        setMediaItems((prev) => {
          const combined = append ? [...prev, ...hydrated] : hydrated;
          const seen = new Set<string>();

          return combined.filter((item) => {
            if (deletedIdsRef.current.has(item.id)) return false;
            if (seen.has(item.id)) return false;
            seen.add(item.id);
            return true;
          });
        });

        setNextCursor(data.nextCursor ?? null);
        if (!append && data.totalCount !== undefined) setTotalCount(data.totalCount);
        if (!append && data.hasExtractedItems !== undefined) setHasUnpackedArchiveBundles(data.hasExtractedItems);
        setError(null);
      } catch (err) {
        if (requestId !== fetchIdRef.current) return;
        const message = err instanceof Error ? err.message : "Unable to load media.";
        setError(message);
      } finally {
        if (!silent && requestId === fetchIdRef.current) {
          if (append) setIsLoadingMore(false);
          else setIsLoading(false);
        }
      }
    },
    [buildQuery, hydrateItems, router]
  );

  // Keep a stable ref to the latest fetchMedia so effects can call it without
  // re-running on layout-only preference changes (e.g. grid column density).
  const fetchMediaRef = useRef(fetchMedia);
  useEffect(() => { fetchMediaRef.current = fetchMedia; }, [fetchMedia]);

  // Handle /library?refresh=1 or ?uploaded=1.
  useEffect(() => {
    const refresh = searchParams.get("refresh") ?? searchParams.get("uploaded");
    if (refresh) {
      setRefreshToken((v) => v + 1);
      const next = new URLSearchParams(searchParams.toString());
      next.delete("refresh");
      next.delete("uploaded");
      const nextQuery = next.toString();
      router.replace(nextQuery ? `${LIBRARY_PATH}?${nextQuery}` : LIBRARY_PATH);
    }
    setHasHandledRefreshParam(true);
  }, [router, searchParams]);

  useEffect(() => {
    if (!hasHandledRefreshParam) return;
    fetchMediaRef.current();
  }, [excludeTagsParam, hasHandledRefreshParam, hideUnpackedItems, q, refreshToken, sort, tagsParam, textState, thumbState]);

  // On bundle mutations, do a silent re-fetch — this also refreshes hasExtractedItems
  // (previously a separate pair of probing requests).
  useEffect(() => {
    const handler = () => { fetchMediaRef.current({ silent: true }); };
    window.addEventListener(BUNDLES_UPDATED_EVENT, handler);
    return () => window.removeEventListener(BUNDLES_UPDATED_EVENT, handler);
  }, []);

  // Fetch tag options when the panel is opened.
  useEffect(() => {
    if (!showTagFilter) return;
    apiFetch('/api/tags?limit=200', { credentials: 'include' })
      .then(r => r.ok ? r.json() : { tags: [] })
      .then((d: { tags: { name: string; count: number; color: string | null; origin?: TagOrigin }[] }) => {
        setTagOptions(d.tags ?? []);
      })
      .catch(() => {});
  }, [showTagFilter]);

  // On any tags mutation: refresh the panel if open, and strip URL tag filters
  // that no longer exist (e.g. all png items deleted while ?tags=png is active).
  useEffect(() => {
    const handler = async () => {
      const { showTagFilter, includedTagsList, excludedTagsList, searchParams } = tagFilterStateRef.current;
      try {
        const res = await apiFetch('/api/tags?limit=200', { credentials: 'include' });
        if (!res.ok) return;
        const data = await res.json() as { tags: { name: string; count: number; color: string | null; origin?: TagOrigin }[] };
        const tags = data.tags ?? [];
        if (showTagFilter) setTagOptions(tags);

        if (includedTagsList.length === 0 && excludedTagsList.length === 0) return;
        const tagNames = new Set(tags.map(t => t.name));
        const newIncluded = includedTagsList.filter(t => tagNames.has(t));
        const newExcluded = excludedTagsList.filter(t => tagNames.has(t));
        if (newIncluded.length !== includedTagsList.length || newExcluded.length !== excludedTagsList.length) {
          const params = new URLSearchParams(searchParams.toString());
          if (newIncluded.length > 0) params.set('tags', newIncluded.join(','));
          else { params.delete('tags'); params.delete('tag'); }
          if (newExcluded.length > 0) params.set('excludeTags', newExcluded.join(','));
          else params.delete('excludeTags');
          const qs = params.toString();
          router.replace(qs ? `${LIBRARY_PATH}?${qs}` : LIBRARY_PATH);
        }
      } catch {}
    };
    window.addEventListener(TAGS_UPDATED_EVENT, handler);
    return () => window.removeEventListener(TAGS_UPDATED_EVENT, handler);
  }, [router]);

  // Debounced silent refetch for list-membership events — bulk deletes and
  // index walks publish one event per chunk/batch, so coalesce bursts into a
  // single fetch instead of refetching per event.
  const listRefetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleListRefetch = useCallback(() => {
    if (listRefetchTimerRef.current !== null) return;
    listRefetchTimerRef.current = setTimeout(() => {
      listRefetchTimerRef.current = null;
      fetchMediaRef.current({ silent: true });
    }, 400);
  }, []);
  useEffect(() => () => {
    if (listRefetchTimerRef.current !== null) clearTimeout(listRefetchTimerRef.current);
  }, []);

  // Server-pushed updates (SSE): per-item worker-state flips patch the grid in
  // place; create/delete events refetch the list — this is what makes bulk
  // deletes, index walks, and other tabs' uploads appear without a manual reload.
  useMediaEvents({
    // Re-fetch on every (re)connect to catch events missed while disconnected.
    onConnect: () => fetchMediaRef.current({ silent: true }),
    onEvent: (event) => {
      if (event.field === "tagsUpdated") {
        emitTagsUpdated();
        return;
      }
      if (event.field === "mediaDeleted" || event.field === "mediaCreated") {
        if (event.field === "mediaDeleted" && event.mediaId !== "*") {
          // Single-item delete carries the id — drop it without waiting.
          deletedIdsRef.current.add(event.mediaId);
          setMediaItems((prev) => prev.filter((item) => item.id !== event.mediaId));
        }
        scheduleListRefetch();
        return;
      }
      setMediaItems((prev) =>
        prev.map((item) => (item.id === event.mediaId ? { ...item, [event.field]: event.value } : item))
      );
    },
  });

  // Same-tab signal from mutations elsewhere in the app (delete completion,
  // purge, unpack) — the media counterpart of the bundles listener above.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<MediaListUpdatedDetail>).detail;
      if (detail?.removedIds?.length) {
        for (const id of detail.removedIds) deletedIdsRef.current.add(id);
        const removed = new Set(detail.removedIds);
        setMediaItems((prev) => prev.filter((item) => !removed.has(item.id)));
      }
      fetchMediaRef.current({ silent: true });
    };
    window.addEventListener(MEDIA_LIST_UPDATED_EVENT, handler);
    return () => window.removeEventListener(MEDIA_LIST_UPDATED_EVENT, handler);
  }, []);

  const handleUploadClick = useCallback(() => {
    router.push("/upload");
  }, [router]);

  const handleLoadMore = useCallback(() => {
    if (!nextCursor) return;
    fetchMedia({ cursor: nextCursor, append: true });
  }, [fetchMedia, nextCursor]);

  // Endless scroll: auto-load the next page as the sentinel nears the viewport.
  const loadMoreSentinelRef = useInfiniteScroll({
    hasMore: !!nextCursor,
    isLoading: isLoadingMore || isLoading,
    onLoadMore: handleLoadMore,
  });

  const handleDelete = useCallback(
    (id: string, e: React.MouseEvent) => {
      if (deletingIds.has(id)) return;
      setConfirmState({
        x: e.clientX,
        y: e.clientY,
        message: "Delete this item? This cannot be undone.",
        action: async () => {
          setDeletingIds((prev) => {
            const next = new Set(prev);
            next.add(id);
            return next;
          });
          try {
            const res = await apiFetch(`/api/media/${id}`, {
              method: "DELETE",
              credentials: "include",
            });
            if (!res.ok) {
              const msg = await readErrorMessage(res);
              setError(msg);
              return;
            }
            deletedIdsRef.current.add(id);
            setMediaItems((prev) => prev.filter((item) => item.id !== id));
            setTotalCount(prev => prev !== null ? prev - 1 : null);
            setError(null);
            emitTagsUpdated();
            emitBundlesUpdated();
            fetchMedia({ silent: true });
          } catch (err) {
            const message = err instanceof Error ? err.message : "Failed to delete media.";
            setError(message);
          } finally {
            setDeletingIds((prev) => {
              const next = new Set(prev);
              next.delete(id);
              return next;
            });
          }
        },
      });
    },
    [deletingIds, fetchMedia]
  );

  const handleDownload = useCallback(async (id: string) => {
    try {
      const res = await apiFetch(`/api/media/${id}/download`, { credentials: "include" });
      if (!res.ok) return;
      const { url } = await res.json() as { url: string };
      window.open(url, "_blank");
    } catch {
      // silent — download is best-effort
    }
  }, []);

  const handleRename = useCallback(
    async (id: string, nextTitle: string) => {
      if (deletingIds.has(id)) return;
      const trimmedTitle = nextTitle.trim();
      if (!trimmedTitle) return;

      try {
        const res = await apiFetch(`/api/media/${id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ title: trimmedTitle }),
        });

        if (!res.ok) {
          const msg = await readErrorMessage(res);
          setError(msg);
          return;
        }

        const data = (await res.json()) as { media?: { title?: string } } | null;
        const updatedTitle = data?.media?.title ?? trimmedTitle;

        setMediaItems((prev) =>
          prev.map((item) =>
            item.id === id ? { ...item, title: updatedTitle } : item
          )
        );
        setError(null);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to rename media.";
        setError(message);
      }
    },
    [deletingIds]
  );

  // Select mode handlers.
  const toggleSelectMode = useCallback(() => {
    setIsSelectMode(prev => !prev);
    setSelectedIds(new Set());
    setIsSelectAllLibrary(false);
    lastSelectedIdRef.current = null;
  }, []);

  const handleSelect = useCallback((id: string, shiftKey: boolean) => {
    if (shiftKey && lastSelectedIdRef.current) {
      const ids = mediaItems.map(m => m.id);
      const from = ids.indexOf(lastSelectedIdRef.current);
      const to = ids.indexOf(id);
      if (from !== -1 && to !== -1) {
        const [start, end] = from < to ? [from, to] : [to, from];
        setSelectedIds(prev => {
          const next = new Set(prev);
          for (let i = start; i <= end; i++) next.add(ids[i]);
          return next;
        });
        lastSelectedIdRef.current = id;
        return;
      }
    }
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    lastSelectedIdRef.current = id;
  }, [mediaItems]);

  useEffect(() => {
    if (mediaItems.length === 0) return;
    sessionStorage.setItem(
      'library:navList',
      JSON.stringify({ ids: mediaItems.map(m => m.id), q })
    );
  }, [mediaItems, q]);

  const handleBulkDownload = useCallback(async () => {
    if (selectedIds.size === 0 || isDownloading) return;
    setIsDownloading(true);
    try {
      const res = await apiFetch("/api/media/bulk-download", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: Array.from(selectedIds) }),
      });
      if (!res.ok) {
        const msg = await readErrorMessage(res);
        setError(msg);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "vault-download.zip";
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to download.";
      setError(message);
    } finally {
      setIsDownloading(false);
    }
  }, [selectedIds, isDownloading]);

  // Re-queue thumbnail/text processing for the hand-picked selection. Used to
  // recover items left at PENDING with no job after Abort Queues. Optimistically
  // flips the affected state to PENDING; SSE flips it to READY as workers finish.
  const handleBatchRequeue = useCallback(
    async (kind: "thumbnail" | "text") => {
      const ids = Array.from(selectedIds);
      if (ids.length === 0 || isRequeueing) return;
      setIsRequeueing(true);
      try {
        if (kind === "thumbnail") {
          await regenerateThumbnailsBatch(ids);
          setMediaItems((prev) =>
            prev.map((item) => (selectedIds.has(item.id) ? { ...item, thumbState: "PENDING" } : item)),
          );
        } else {
          await extractTextBatch(ids);
          setMediaItems((prev) =>
            prev.map((item) => (selectedIds.has(item.id) ? { ...item, textState: "PENDING" } : item)),
          );
        }
        setIsSelectMode(false);
        setSelectedIds(new Set());
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to start processing.";
        setError(message);
      } finally {
        setIsRequeueing(false);
      }
    },
    [selectedIds, isRequeueing],
  );

  const handleBulkDelete = useCallback((info: { centerX: number; anchorWidth: number; topOffset: number }) => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0 && !isSelectAllLibrary) return;
    const count = isSelectAllLibrary ? (totalCount ?? ids.length) : ids.length;
    setConfirmState({
      x: info.centerX,
      y: 0,
      anchorWidth: info.anchorWidth,
      topOffset: info.topOffset,
      message: `Delete ${count} ${count === 1 ? "item" : "items"}? This cannot be undone.`,
      action: async () => {
        // Both paths enqueue a background job and return immediately — the worker
        // does the set-based delete + thumbnail unlinks off the request thread, so
        // a huge selection never hangs the request or starves the DB pool. The
        // LibraryUpdateBanner shows progress; the done-reconcile effect below
        // re-fetches silently when the job finishes.
        try {
          if (isSelectAllLibrary) {
            // Delete everything matching the current filter (worker re-selects in chunks).
            // Don't re-fetch immediately — the banner tracks progress and the
            // done-reconcile effect below handles the silent list update on finish.
            const qs = buildDeleteAllQuery();
            await startBulkDeleteJob({ query: qs });
            setIsSelectAllLibrary(false);
          } else {
            // Hand-picked ids — remove from view immediately, then reconcile.
            await startBulkDeleteJob({ ids });
            const idSet = new Set(ids);
            ids.forEach(id => deletedIdsRef.current.add(id));
            setMediaItems(prev => prev.filter(item => !idSet.has(item.id)));
            setTotalCount(prev => prev !== null ? Math.max(0, prev - ids.length) : null);
            fetchMedia({ silent: true });
          }
          setIsSelectMode(false);
          setSelectedIds(new Set());
        } catch (err) {
          const message = err instanceof Error ? err.message : "Failed to start delete.";
          setError(message);
        }
      },
    });
  }, [selectedIds, fetchMedia, isSelectAllLibrary, totalCount, buildDeleteAllQuery, startBulkDeleteJob]);

  // When a tracked bulk delete finishes, reconcile the list once: a silent
  // re-fetch drops any items the worker removed (covers the select-all path,
  // where the client can't know which ids matched the filter).
  useEffect(() => {
    if (!bulkDeleteStatus || !bulkDeleteStatus.done) return;
    if (reconciledDeleteJobRef.current === bulkDeleteStatus.jobId) return;
    reconciledDeleteJobRef.current = bulkDeleteStatus.jobId;
    setTotalCount(null);
    fetchMedia({ silent: true });
  }, [bulkDeleteStatus, fetchMedia]);

  // Drag & drop handlers (no window/global pattern)
  const onDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    // Only show overlay for file drags
    if (!e.dataTransfer?.types?.includes("Files")) return;
    dragDepthRef.current += 1;
    setIsDragging(true);
  }, []);

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (!e.dataTransfer?.types?.includes("Files")) return;
    e.dataTransfer.dropEffect = "copy";
    setIsDragging(true);
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (!e.dataTransfer?.types?.includes("Files")) return;
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDragging(false);
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      dragDepthRef.current = 0;
      setIsDragging(false);

      const dt = e.dataTransfer;
      if (!dt?.files || dt.files.length === 0) return;

      const files = Array.from(dt.files);
      addFiles(files);
      router.push("/upload");
    },
    [addFiles, router]
  );

  // Shared card renderer so the flat and year-grouped layouts stay identical.
  // gridCols only applies to grid cards (list cards never received it).
  const renderMediaCard = (media: MediaItem, index: number) => (
    <MediaCard
      key={media.id}
      media={media}
      variant={viewMode}
      density={cardDensity}
      {...(viewMode === "grid" ? { gridCols } : {})}
      loading={index < EAGER_THUMB_COUNT ? "eager" : "lazy"}
      onDownload={isSelectMode ? undefined : (id) => void handleDownload(id)}
      onDelete={isSelectMode ? undefined : handleDelete}
      onRename={isSelectMode ? undefined : handleRename}
      onStarToggle={isSelectMode ? undefined : handleStarToggle}
      isDeleting={deletingIds.has(media.id)}
      isSelectMode={isSelectMode}
      isSelected={selectedIds.has(media.id)}
      onSelect={handleSelect}
    />
  );

  // Year sort layout: collapsible year headers with month sub-headers between
  // card runs. col-span-full makes the headings span the CSS grid; in list
  // mode they render as full-width rows inside the bordered list container.
  const renderDateGroups = () =>
    (dateGroups ?? []).map(year => {
      const isCollapsed = collapsedYears.has(year.key);
      const itemCount = year.months.reduce((n, m) => n + m.entries.length, 0);
      return (
        <Fragment key={year.key}>
          <h2
            className={`col-span-full ${
              viewMode === "list" ? "bg-muted/30 px-4 py-2" : "mt-2 first:mt-0"
            }`}
          >
            <button
              type="button"
              onClick={() => toggleYearCollapsed(year.key)}
              aria-expanded={!isCollapsed}
              className="flex w-full cursor-pointer items-center gap-2 text-left"
            >
              <ChevronDown
                className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${
                  isCollapsed ? "-rotate-90" : ""
                }`}
              />
              <span className="text-lg font-semibold tracking-tight">{year.label}</span>
              <span className="text-sm font-normal text-muted-foreground">
                {itemCount} item{itemCount === 1 ? "" : "s"}
              </span>
              <span aria-hidden className="ml-2 h-px flex-1 bg-border" />
            </button>
          </h2>
          {!isCollapsed &&
            year.months.map(month => (
              <Fragment key={month.key}>
                {month.label && (
                  <h3
                    className={`col-span-full text-sm font-medium text-muted-foreground ${
                      viewMode === "list" ? "bg-muted/20 px-4 py-1.5" : ""
                    }`}
                  >
                    {month.label}
                  </h3>
                )}
                {month.entries.map(({ media, index }) => renderMediaCard(media, index))}
              </Fragment>
            ))}
        </Fragment>
      );
    });

  return (
    <Container className="py-6">
      <PageHeader
        title="Media Library"
        description={totalCount !== null ? `Browse and manage your media files · ${totalCount} item${totalCount === 1 ? "" : "s"}` : "Browse and manage your media files"}
        actions={
          <>
            {!isSelectMode && (
              <Button
                variant="outline"
                size="sm"
                onClick={toggleSelectMode}
              >
                Select
              </Button>
            )}

            {!isSelectMode && (
              <Button size="sm" onClick={handleUploadClick}>
                <Plus className="mr-2 h-4 w-4" />
                Upload Media
              </Button>
            )}
          </>
        }
      />

      {error && (
        <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <LibraryUpdateBanner />

      {(mediaItems.length > 0 || hasAnyFilter) && (
        <div className="mb-4 flex flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-3">
            {/* Left zone: filter controls */}
            <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground pointer-events-none" />
              <input
                type="text"
                placeholder="Filter by title/text..."
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                className="h-9 w-48 rounded-md border border-input bg-background pl-8 pr-8 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              {searchInput && (
                <button
                  type="button"
                  onClick={() => setSearchInput("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  aria-label="Clear search"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            <Button
              variant={(includedTagsList.length + excludedTagsList.length) > 0 ? "default" : showTagFilter ? "secondary" : "outline"}
              size="sm"
              onClick={() => { setShowTagFilter(prev => { if (prev) setTagSearch(""); return !prev; }); }}
            >
              <Tag className="mr-2 h-4 w-4" />
              {(includedTagsList.length + excludedTagsList.length) > 0
                ? `Tags (${includedTagsList.length + excludedTagsList.length})`
                : "Filter by tag"}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="flex items-center gap-2">
                  <span>{sortLabel}</span>
                  <ChevronDown className="h-4 w-4 opacity-70" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-[12rem]">
                {SORT_OPTIONS.map((option) => (
                  <DropdownMenuItem
                    key={option.value}
                    onClick={() => handleSortChange(option.value)}
                    className={option.value === sort ? "font-semibold" : "text-muted-foreground"}
                  >
                    {option.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            {DevPurgeButton && (
              <DevPurgeButton
                // The purge is a background job that has only just been ENQUEUED
                // here — don't refetch or zero anything yet. The delete-progress
                // banner tracks it, and its completion emits the media/tag/bundle
                // events that refresh this page.
                onSuccess={() => { setError(null); router.replace(LIBRARY_PATH); }}
                onError={setError}
              />
            )}
            </div>

            {/* Right zone: status filter + view controls */}
            <div className="flex items-center gap-2">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant={statusValue === "all" ? "outline" : "default"}
                    size="sm"
                    className="flex items-center gap-2"
                  >
                    <span>{statusLabel}</span>
                    <ChevronDown className="h-4 w-4 opacity-70" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-[12rem]">
                  {STATUS_OPTIONS.map((option) => (
                    <DropdownMenuItem
                      key={option.value}
                      onClick={() => handleStatusChange(option.value)}
                      className={option.value === statusValue ? "font-semibold" : "text-muted-foreground"}
                    >
                      {option.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              {viewMode === "grid" && mediaItems.length > 0 && (
                <div className="w-72">
                  <input
                    type="range"
                    min={DENSITY_OPTIONS[0]}
                    max={DENSITY_OPTIONS[DENSITY_OPTIONS.length - 1]}
                    step={1}
                    value={gridCols}
                    onChange={(e) => {
                      updatePreferences({ libraryGridCols: Number(e.target.value) as DensityValue });
                    }}
                    aria-label="Grid density"
                    className="w-full h-4 accent-primary cursor-pointer"
                  />
                  <div aria-hidden className="pointer-events-none flex items-center justify-between px-1 text-primary">
                    {DENSITY_OPTIONS.map(n => (
                      <span key={`density-notch-${n}`} className="block h-3 w-[2px] rounded-full bg-current opacity-80" />
                    ))}
                  </div>
                </div>
              )}

              {viewMode === "list" && (
                <Button
                  variant={isCompactList ? "default" : "outline"}
                  size="sm"
                  aria-pressed={isCompactList}
                  onClick={() => {
                    updatePreferences({ libraryIsCompactList: !isCompactList });
                  }}
                >
                  {isCompactList ? "Compact" : "Comfortable"}
                </Button>
              )}

              <div className="flex items-center rounded-md border p-0.5 gap-0.5">
                <button
                  type="button"
                  aria-label="Grid view"
                  aria-pressed={viewMode === "grid"}
                  onClick={() => updatePreferences({ libraryViewMode: "grid" })}
                  className={`rounded p-1.5 transition-colors ${viewMode === "grid" ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground hover:bg-muted"}`}
                >
                  <LayoutGrid className="h-4 w-4" suppressHydrationWarning />
                </button>
                <button
                  type="button"
                  aria-label="List view"
                  aria-pressed={viewMode === "list"}
                  onClick={() => updatePreferences({ libraryViewMode: "list" })}
                  className={`rounded p-1.5 transition-colors ${viewMode === "list" ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground hover:bg-muted"}`}
                >
                  <LayoutList className="h-4 w-4" suppressHydrationWarning />
                </button>
              </div>
            </div>
          </div>

          {showTagFilter && (
            <div className="flex flex-col gap-2 rounded-md border bg-muted/30 px-3 py-2.5">
              {tagOptions.length > 8 && (
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground pointer-events-none" />
                  <input
                    value={tagSearch}
                    onChange={e => setTagSearch(e.target.value)}
                    placeholder="Filter tags…"
                    className="w-full rounded-md border border-input bg-background pl-7 pr-3 py-1.5 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  />
                </div>
              )}
              <div className="flex flex-wrap items-center gap-1.5">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2.5 text-xs"
                  onClick={clearAllFilters}
                >
                  <X className="h-3 w-3 mr-1" />
                  Clear filters
                </Button>
                {filteredTagOptions.length > 0 ? (
                  filteredTagOptions.map(t => (
                    <TagFilterChip
                      key={t.name}
                      tag={t.name}
                      state={getTagFilterState(t.name)}
                      onCycle={cycleTag}
                      color={t.color}
                      count={t.count}
                      origin={t.origin}
                    />
                  ))
                ) : (
                  <p className="text-xs text-muted-foreground py-0.5">
                    {tagOptions.length === 0 ? "No tags yet." : "No tags match your search."}
                  </p>
                )}
              </div>
            </div>
          )}

          {!tag && !q && hasUnpackedArchiveBundles && (
            <div>
              <Button
                variant={hideUnpackedItems ? "outline" : "default"}
                size="sm"
                aria-pressed={!hideUnpackedItems}
                onClick={() => updatePreferences({ hideUnpackedItems: !hideUnpackedItems })}
                className="h-7 px-2.5 text-xs"
              >
                {hideUnpackedItems ? "Show unpacked ZIPs" : "Hide unpacked ZIPs"}
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Selection toolbar — sticky at the top of the scroll container; owns
          every select-all control (visible → whole library → clear). */}
      {isSelectMode && (
        <BulkActionBar
          count={isSelectAllLibrary ? (totalCount ?? selectedIds.size) : selectedIds.size}
          visibleCount={mediaItems.length}
          totalCount={totalCount}
          isSelectAllLibrary={isSelectAllLibrary}
          onSelectAllLibraryChange={setIsSelectAllLibrary}
          onDelete={(info) => handleBulkDelete(info)}
          onTag={() => setIsTagDialogOpen(true)}
          onAddToBundle={() => setIsBundleDialogOpen(true)}
          onClear={() => { setSelectedIds(new Set()); setIsSelectAllLibrary(false); lastSelectedIdRef.current = null; }}
          onDownload={handleBulkDownload}
          onRegenerateThumbnail={() => handleBatchRequeue("thumbnail")}
          onExtractText={() => handleBatchRequeue("text")}
          onCancel={toggleSelectMode}
          onSelectAll={() => setSelectedIds(new Set(mediaItems.map(m => m.id)))}
          isDownloading={isDownloading}
          isRequeueing={isRequeueing}
        />
      )}

      {/* Unified drag-drop wrapper + overlay (single overlay, no custom globals needed) */}
      <div
        className="relative"
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {isDragging && (
          <div className="absolute inset-0 z-50 flex items-center justify-center rounded-lg border-2 border-dashed border-primary bg-primary/10">
            <div className="text-center">
              <Upload className="mx-auto mb-2 h-12 w-12 text-primary" />
              <p className="text-lg font-semibold text-primary">Drop files to upload</p>
            </div>
          </div>
        )}

        {viewMode === "list" ? (
          <>
            {(isLoading || mediaItems.length > 0) ? (
              <div className="rounded-2xl border overflow-hidden">
                <MediaCardListHeader density={cardDensity} isSelectMode={isSelectMode} />
                <div className={layoutClass}>
                  {isLoading && mediaItems.length === 0
                    ? Array.from({ length: 6 }).map((_, i) => (
                        <MediaCardSkeleton key={i} variant={viewMode} density={cardDensity} />
                      ))
                    : dateGroups
                      ? renderDateGroups()
                      : mediaItems.map((media, index) => renderMediaCard(media, index))
                  }
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <p className="mb-4 text-lg text-muted-foreground">No media items found</p>
                {nextCursor ? (
                  <Button variant="outline" onClick={handleLoadMore} disabled={isLoadingMore}>
                    {isLoadingMore ? "Loading more..." : "Load more"}
                  </Button>
                ) : (
                  <Button onClick={handleUploadClick}>
                    <Plus className="mr-2 h-4 w-4" />
                    {hasAnyFilter ? "Upload" : "Upload Your First Item"}
                  </Button>
                )}
              </div>
            )}
          </>
        ) : (
          <>
            {isLoading && mediaItems.length === 0 ? (
              <div className={layoutClass}>
                {Array.from({ length: 6 }).map((_, i) => (
                  <MediaCardSkeleton key={i} variant={viewMode} density={cardDensity} />
                ))}
              </div>
            ) : mediaItems.length > 0 ? (
              <div className={layoutClass}>
                {dateGroups
                  ? renderDateGroups()
                  : mediaItems.map((media, index) => renderMediaCard(media, index))}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <p className="mb-4 text-lg text-muted-foreground">No media items found</p>
                {nextCursor ? (
                  <Button variant="outline" onClick={handleLoadMore} disabled={isLoadingMore}>
                    {isLoadingMore ? "Loading more..." : "Load more"}
                  </Button>
                ) : (
                  <Button onClick={handleUploadClick}>
                    <Plus className="mr-2 h-4 w-4" />
                    {hasAnyFilter ? "Upload" : "Upload Your First Item"}
                  </Button>
                )}
              </div>
            )}
          </>
        )}

        {nextCursor && mediaItems.length > 0 && (
          <div ref={loadMoreSentinelRef} className="mt-6 flex justify-center py-4" aria-hidden={!isLoadingMore}>
            {isLoadingMore && (
              <span className="text-sm text-muted-foreground">Loading more…</span>
            )}
          </div>
        )}
      </div>
      <ConfirmPopover
        open={confirmState !== null}
        x={confirmState?.x ?? 0}
        y={confirmState?.y ?? 0}
        anchorWidth={confirmState?.anchorWidth}
        bottomOffset={confirmState?.bottomOffset}
        topOffset={confirmState?.topOffset}
        message={confirmState?.message ?? "Delete? This cannot be undone."}
        onConfirm={() => {
          const action = confirmState?.action;
          setConfirmState(null);
          void action?.();
        }}
        onCancel={() => setConfirmState(null)}
      />

      {/* Bulk tag dialog */}
      <BulkTagDialog
        open={isTagDialogOpen}
        onOpenChange={setIsTagDialogOpen}
        selectedItems={mediaItems.filter(m => selectedIds.has(m.id))}
        onDone={(updatedItems) => {
          setMediaItems(prev =>
            prev.map(item => {
              const updated = updatedItems.find(u => u.id === item.id);
              return updated ?? item;
            })
          );
          setIsSelectMode(false);
          setSelectedIds(new Set());
        }}
      />

      {/* Bulk bundle dialog */}
      <BulkBundleDialog
        open={isBundleDialogOpen}
        onOpenChange={setIsBundleDialogOpen}
        selectedIds={Array.from(selectedIds)}
        onDone={() => {
          setIsSelectMode(false);
          setSelectedIds(new Set());
        }}
      />
    </Container>
  );
}
