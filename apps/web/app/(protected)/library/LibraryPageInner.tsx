// File: apps/web/app/(protected)/library/LibraryPageInner.tsx
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePreferences } from "@/hooks/usePreferences";
import { useRouter, useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";

const DevPurgeButton =
  process.env.NODE_ENV === "development"
    ? dynamic(() => import("@/components/dev/DevPurgeButton"))
    : null;
import { Container, PageHeader } from "@/components/common";
import { MediaCard, MediaCardSkeleton, type MediaItem } from "@/components/media";
import { BulkActionBar } from "@/components/media/BulkActionBar";
import { BulkTagDialog } from "@/components/media/BulkTagDialog";
import { BulkBundleDialog } from "@/components/media/BulkBundleDialog";
import { Button } from "@/components/ui/Button";
import { ConfirmPopover } from "@/components/ui/ConfirmPopover";
import { Plus, LayoutGrid, LayoutList, Upload, ChevronDown, Search, X } from "lucide-react";
import { useUpload } from "@/components/contexts/UploadContext";
import { emitTagsUpdated } from "@/lib/tags";
import { emitBundlesUpdated } from "@/lib/bundles";
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
] as const;

type SortValue = (typeof SORT_OPTIONS)[number]["value"];
type DensityValue = (typeof DENSITY_OPTIONS)[number];

// Default query param values.
const DEFAULT_SORT: SortValue = "createdAt_desc";
const LIBRARY_PATH = "/library";

type MediaListItem = {
  id: string;
  title: string;
  thumbState: MediaItem["thumbState"];
  textState: MediaItem["textState"];
  tags?: string[];
  mimeType?: string | null;
  createdAt: string;
};

type MediaListResponse = {
  items: MediaListItem[];
  nextCursor?: string | null;
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

export default function LibraryPageInner() {
  const router = useRouter();

  // Upload context.
  const { addFiles } = useUpload();

  // List fetch state.
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [mediaItems, setMediaItems] = useState<MediaItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Delete coordination.
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());
  const deletedIdsRef = useRef<Set<string>>(new Set());
  const fetchIdRef = useRef(0);

  // Select mode.
  const [isSelectMode, setIsSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isTagDialogOpen, setIsTagDialogOpen] = useState(false);
  const [isBundleDialogOpen, setIsBundleDialogOpen] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);

  // Delete confirmation popover.
  const [confirmState, setConfirmState] = useState<{ x: number; y: number; message: string; action: () => void } | null>(null);

  // Refresh control.
  const [refreshToken, setRefreshToken] = useState(0);
  const [hasHandledRefreshParam, setHasHandledRefreshParam] = useState(false);

  // View + density controls.
  const { prefs, updatePreferences } = usePreferences();
  const viewMode = prefs.libraryViewMode;
  const gridCols = prefs.libraryGridCols;
  const isCompactList = prefs.libraryIsCompactList;
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
  const tag = useMemo(() => {
    if (singleTag) return singleTag;
    return (
      tagsParam
        .split(",")
        .map((t) => t.trim())
        .find(Boolean) ?? ""
    );
  }, [singleTag, tagsParam]);
  const thumbState = searchParams.get("thumbState")?.trim() ?? "";
  const textState = searchParams.get("textState")?.trim() ?? "";
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
      if (q) params.set("q", q);
      if (tag) params.set("tags", tag);
      if (thumbState) params.set("thumbState", thumbState);
      if (textState) params.set("textState", textState);
      if (cursor) params.set("cursor", cursor);
      return params.toString();
    },
    [gridCols, isCompactGrid, q, sort, tag, textState, thumbState, viewMode]
  );

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


  const hydrateItems = useCallback((list: MediaListItem[]) => {
    return list.map((item) => {
      return {
        id: item.id,
        title: item.title,
        thumbState: item.thumbState,
        textState: item.textState,
        tags: item.tags,
        mimeType: item.mimeType,
      } satisfies MediaItem;
    });
  }, []);

  const fetchMedia = useCallback(
    async (opts?: { cursor?: string; append?: boolean; silent?: boolean }) => {
      const cursor = opts?.cursor;
      const append = opts?.append ?? false;
      const silent = opts?.silent ?? false;
      const requestId = ++fetchIdRef.current;

      if (!silent) {
        if (append) setIsLoadingMore(true);
        else {
          setIsLoading(true);
          setMediaItems([]);
        }
      }

      if (process.env.NODE_ENV === "development") {
        console.debug("[library] list request", { cursor: cursor ?? null, append });
      }

      try {
        const res = await fetch(`/api/media?${buildQuery(cursor)}`, {
          method: "GET",
          credentials: "include",
        });

        if (requestId !== fetchIdRef.current) return;

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
    [buildQuery, hydrateItems]
  );

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
    fetchMedia();
  }, [fetchMedia, hasHandledRefreshParam, q, refreshToken, sort, tag, textState, thumbState]);

  // Keep a stable ref to the latest fetchMedia so the SSE effect never needs
  // to re-run (and reconnect) just because gridCols or sort changed.
  const fetchMediaRef = useRef(fetchMedia);
  useEffect(() => { fetchMediaRef.current = fetchMedia; }, [fetchMedia]);

  // SSE: receive job-state updates pushed from the server instead of polling.
  // Empty deps — mounts once. Uses fetchMediaRef so it always calls the latest
  // version without causing reconnects on every buildQuery/gridCols change.
  useEffect(() => {
    const es = new EventSource("/api/media/events");

    // Once the SSE connection is fully established on the server, do a silent
    // re-fetch to catch any items that finished processing in the window between
    // the initial fetchMedia call and the SSE listener being registered.
    es.onopen = () => {
      fetchMediaRef.current({ silent: true });
    };

    es.onmessage = (e: MessageEvent<string>) => {
      try {
        const { mediaId, field, value } = JSON.parse(e.data) as {
          mediaId?: string;
          field?: "textState" | "thumbState";
          value?: string;
        };
        if (!mediaId || !field || !value) return;
        setMediaItems((prev) =>
          prev.map((item) => (item.id === mediaId ? { ...item, [field]: value } : item))
        );
      } catch {
        // ignore malformed frames
      }
    };

    // On reconnect after a gap, re-fetch the full list to catch any missed updates
    es.onerror = () => {
      fetchMediaRef.current({ silent: true });
    };

    return () => es.close();
  }, []);

  const handleUploadClick = useCallback(() => {
    router.push("/upload");
  }, [router]);

  const handleLoadMore = useCallback(() => {
    if (!nextCursor) return;
    fetchMedia({ cursor: nextCursor, append: true });
  }, [fetchMedia, nextCursor]);

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
            const res = await fetch(`/api/media/${id}`, {
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
            setError(null);
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
      const res = await fetch(`/api/media/${id}/download`, { credentials: "include" });
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
        const res = await fetch(`/api/media/${id}`, {
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
  }, []);

  const handleSelect = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleBulkDownload = useCallback(async () => {
    if (selectedIds.size === 0 || isDownloading) return;
    setIsDownloading(true);
    try {
      const res = await fetch("/api/media/bulk-download", {
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

  const handleBulkDelete = useCallback((e: React.MouseEvent) => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    setConfirmState({
      x: e.clientX,
      y: e.clientY,
      message: `Delete ${ids.length} item(s)? This cannot be undone.`,
      action: async () => {

    setDeletingIds(prev => {
      const next = new Set(prev);
      ids.forEach(id => next.add(id));
      return next;
    });

    const results = await Promise.allSettled(
      ids.map(id =>
        fetch(`/api/media/${id}`, { method: 'DELETE', credentials: 'include' })
      )
    );

    const deleted: string[] = [];
    results.forEach((result, i) => {
      if (result.status === 'fulfilled' && result.value.ok) {
        deleted.push(ids[i]);
        deletedIdsRef.current.add(ids[i]);
      }
    });

    setMediaItems(prev => prev.filter(item => !deleted.includes(item.id)));
    setSelectedIds(prev => {
      const next = new Set(prev);
      deleted.forEach(id => next.delete(id));
      return next;
    });
    setDeletingIds(prev => {
      const next = new Set(prev);
      ids.forEach(id => next.delete(id));
      return next;
    });

    if (deleted.length > 0) {
      fetchMedia({ silent: true });
      if (deleted.length === ids.length) {
        setIsSelectMode(false);
        setSelectedIds(new Set());
      }
    }
      },
    });
  }, [selectedIds, fetchMedia]);

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

  return (
    <Container className="py-6">
      <PageHeader
        title="Media Library"
        description="Browse and manage your media files"
        actions={
          <>
            <Button
              variant={isSelectMode ? "default" : "outline"}
              size="sm"
              onClick={toggleSelectMode}
            >
              {isSelectMode ? "Cancel" : "Select"}
            </Button>

            {isSelectMode && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSelectedIds(new Set(mediaItems.map(m => m.id)))}
              >
                Select All
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

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground pointer-events-none" />
            <input
              type="text"
              placeholder="Filter by title..."
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

          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              updatePreferences({ libraryViewMode: viewMode === "grid" ? "list" : "grid" });
            }}
          >
            {viewMode === "grid" ? (
              <>
                <LayoutList className="mr-2 h-4 w-4" suppressHydrationWarning />
                List View
              </>
            ) : (
              <>
                <LayoutGrid className="mr-2 h-4 w-4" suppressHydrationWarning />
                Grid View
              </>
            )}
          </Button>

          {DevPurgeButton && viewMode === "grid" && (
            <DevPurgeButton
              onSuccess={() => { setMediaItems([]); setNextCursor(null); setError(null); emitTagsUpdated(); emitBundlesUpdated(); }}
              onError={setError}
            />
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

        </div>

        {viewMode === "grid" && (
          <div className="flex flex-col items-end gap-1">
            <input
              type="range"
              min={DENSITY_OPTIONS[0]}
              max={DENSITY_OPTIONS[DENSITY_OPTIONS.length - 1]}
              step={1}
              value={gridCols}
              list="density-ticks"
              onChange={(e) => {
                updatePreferences({ libraryGridCols: Number(e.target.value) as DensityValue });
              }}
              aria-label="Grid density"
              className="w-72 h-4 accent-primary cursor-pointer"
            />
            <datalist id="density-ticks">
              {DENSITY_OPTIONS.map(n => <option key={n} value={n} />)}
            </datalist>
            <span className="mt-1 text-xs font-medium text-foreground leading-none h-4">
              {isCompactGrid ? "compact" : ""}
            </span>
          </div>
        )}
      </div>

      {/* Unified drag-drop wrapper + overlay (single overlay, no custom globals needed) */}
      <div
        className={isSelectMode && selectedIds.size > 0 ? "relative pb-20" : "relative"}
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

        {isLoading && mediaItems.length === 0 ? (
          <div className={layoutClass}>
            {Array.from({ length: 6 }).map((_, i) => (
              <MediaCardSkeleton
                key={i}
                variant={viewMode}
                density={cardDensity}
              />
            ))}
          </div>
        ) : mediaItems.length > 0 ? (
          <div className={layoutClass}>
            {mediaItems.map((media, index) => (
              <MediaCard
                key={media.id}
                media={media}
                variant={viewMode}
                density={cardDensity}
                gridCols={viewMode === 'grid' ? gridCols : undefined}
                loading={index < EAGER_THUMB_COUNT ? "eager" : "lazy"}
                onDownload={isSelectMode ? undefined : (id) => void handleDownload(id)}
                onDelete={isSelectMode ? undefined : handleDelete}
                onRename={isSelectMode ? undefined : handleRename}
                isDeleting={deletingIds.has(media.id)}
                isSelectMode={isSelectMode}
                isSelected={selectedIds.has(media.id)}
                onSelect={handleSelect}
              />
            ))}
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
                Upload Your First Item
              </Button>
            )}
          </div>
        )}

        {nextCursor && mediaItems.length > 0 && (
          <div className=" mt-6 flex justify-center">
            <Button variant="outline" onClick={handleLoadMore} disabled={isLoadingMore}> 
              {isLoadingMore ? "Loading more..." : "Load more"}
            </Button>
          </div>
        )}
      </div>
      {/* Bulk action bar */}
      {isSelectMode && selectedIds.size > 0 && (
        <BulkActionBar
          count={selectedIds.size}
          onDelete={(e) => handleBulkDelete(e)}
          onTag={() => setIsTagDialogOpen(true)}
          onAddToBundle={() => setIsBundleDialogOpen(true)}
          onClear={() => setSelectedIds(new Set())}
          onDownload={handleBulkDownload}
          isDownloading={isDownloading}
        />
      )}

      <ConfirmPopover
        open={confirmState !== null}
        x={confirmState?.x ?? 0}
        y={confirmState?.y ?? 0}
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
