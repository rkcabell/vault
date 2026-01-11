// File: apps/web/app/(protected)/overview/page.tsx
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Container, PageHeader } from "@/components/common";
import { MediaCard, MediaCardSkeleton, type MediaItem } from "@/components/media";
import { Button } from "@/components/ui/Button";
import { Plus, LayoutGrid, LayoutList, Upload } from "lucide-react";
import { useUpload } from "@/components/contexts/UploadContext"; 

const PAGE_SIZE = 24;
const DEFAULT_SORT = "createdAt_desc";

type MediaListItem = {
  id: string;
  title: string;
  thumbState: MediaItem["thumbState"];
  textState: MediaItem["textState"];
  tags?: string[];
  thumbnailKey?: string | null;
  mimeType?: string | null;
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

async function fetchThumbnailUrl(id: string) {
  const res = await fetch(`/api/media/${id}/thumbnail`, {
    method: "GET",
    credentials: "include",
  });
  if (!res.ok) return undefined;
  const data = await res.json();
  return data?.url as string | undefined;
}

export default function Overview() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const { addFiles } = useUpload();

  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [mediaItems, setMediaItems] = useState<MediaItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());
  const deletedIdsRef = useRef<Set<string>>(new Set());
  const fetchIdRef = useRef(0);

  const [refreshToken, setRefreshToken] = useState(0);
  const [hasHandledRefreshParam, setHasHandledRefreshParam] = useState(false);

  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");

  // Drag/drop overlay state (robust against child enter/leave flicker)
  const [isDragging, setIsDragging] = useState(false);
  const dragDepthRef = useRef(0);

  const q = searchParams.get("q")?.trim() ?? "";
  const tag = searchParams.get("tag")?.trim() ?? "";
  const thumbState = searchParams.get("thumbState")?.trim() ?? "";
  const textState = searchParams.get("textState")?.trim() ?? "";
  const sort = searchParams.get("sort")?.trim() ?? DEFAULT_SORT;

  const layoutClass =
    viewMode === "grid"
      ? "grid grid-cols-1 items-start gap-4 md:grid-cols-2 lg:grid-cols-3"
      : "space-y-4";

  const buildQuery = useCallback(
    (cursor?: string) => {
      const params = new URLSearchParams();
      params.set("limit", String(PAGE_SIZE));
      params.set("sort", sort);
      if (q) params.set("q", q);
      if (tag) params.set("tag", tag);
      if (thumbState) params.set("thumbState", thumbState);
      if (textState) params.set("textState", textState);
      if (cursor) params.set("cursor", cursor);
      return params.toString();
    },
    [q, sort, tag, textState, thumbState]
  );

  const hydrateItems = useCallback(async (list: MediaListItem[]) => {
    const hydrated = await Promise.all(
      list.map(async (item) => {
        let thumbnailUrl: string | undefined;

        const shouldFetchThumbnail =
          Boolean(item.thumbnailKey) || Boolean(item.mimeType?.startsWith("image/"));

        if (shouldFetchThumbnail) {
          try {
            thumbnailUrl = await fetchThumbnailUrl(item.id);
          } catch {
            thumbnailUrl = undefined;
          }
        }

        return {
          id: item.id,
          title: item.title,
          thumbState: item.thumbState,
          textState: item.textState,
          tags: item.tags,
          thumbnailUrl,
        } satisfies MediaItem;
      })
    );

    return hydrated;
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
        const hydrated = await hydrateItems(data.items ?? []);
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

  // Handle /overview?refresh=1 or ?uploaded=1
  useEffect(() => {
    const refresh = searchParams.get("refresh") ?? searchParams.get("uploaded");
    if (refresh) {
      setRefreshToken((v) => v + 1);

      const next = new URLSearchParams(searchParams.toString());
      next.delete("refresh");
      next.delete("uploaded");
      const nextQuery = next.toString();

      router.replace(nextQuery ? `/overview?${nextQuery}` : "/overview");
    }
    setHasHandledRefreshParam(true);
  }, [router, searchParams]);

  useEffect(() => {
    if (!hasHandledRefreshParam) return;
    fetchMedia();
  }, [fetchMedia, hasHandledRefreshParam, q, refreshToken, sort, tag, textState, thumbState]);

  // Poll while anything is pending
  const hasPending = useMemo(
    () =>
      mediaItems.some(
        (item) => item.thumbState === "PENDING" || item.textState === "PENDING"
      ),
    [mediaItems]
  );

  useEffect(() => {
    if (!hasPending) return;
    const intervalId = setInterval(() => {
      fetchMedia({ silent: true });
    }, 5000);
    return () => clearInterval(intervalId);
  }, [fetchMedia, hasPending]);

  const handleUploadClick = useCallback(() => {
    router.push("/upload");
  }, [router]);

  const handleLoadMore = useCallback(() => {
    if (!nextCursor) return;
    fetchMedia({ cursor: nextCursor, append: true });
  }, [fetchMedia, nextCursor]);

  const handleDelete = useCallback(
    async (id: string) => {
      if (deletingIds.has(id)) return;

      const confirmed = window.confirm("Delete this media item? This cannot be undone.");
      if (!confirmed) return;

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

        // Optimistic remove + prevent resurrection on refetch/append
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
    [deletingIds, fetchMedia]
  );

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
              variant="outline"
              size="sm"
              onClick={() => setViewMode(viewMode === "grid" ? "list" : "grid")}
            >
              {viewMode === "grid" ? (
                <>
                  <LayoutList className="mr-2 h-4 w-4" />
                  List View
                </>
              ) : (
                <>
                  <LayoutGrid className="mr-2 h-4 w-4" />
                  Grid View
                </>
              )}
            </Button>

            <Button size="sm" onClick={handleUploadClick}>
              <Plus className="mr-2 h-4 w-4" />
              Upload Media
            </Button>
          </>
        }
      />

      {error && (
        <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
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

        {isLoading && mediaItems.length === 0 ? (
          <div className={layoutClass}>
            {Array.from({ length: 6 }).map((_, i) => (
              <MediaCardSkeleton key={i} variant={viewMode} />
            ))}
          </div>
        ) : mediaItems.length > 0 ? (
          <div className={layoutClass}>
            {mediaItems.map((media) => (
              <MediaCard
                key={media.id}
                media={media}
                variant={viewMode}
                onDownload={(id) => console.log("Download:", id)}
                onDelete={handleDelete}
                isDeleting={deletingIds.has(media.id)}
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
          <div className="mt-6 flex justify-center">
            <Button variant="outline" onClick={handleLoadMore} disabled={isLoadingMore}>
              {isLoadingMore ? "Loading more..." : "Load more"}
            </Button>
          </div>
        )}
      </div>
    </Container>
  );
}
