"use client";

import React, { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Container, PanelCard } from "@/components/common";
import { Button } from "@/components/ui/Button";
import { Card, CardContent } from "@/components/ui/Card";
import { Skeleton } from "@/components/ui/Skeleton";

import { parseSearchTerms, readErrorMessage } from "@/lib/media/utils";
import { TAGS_UPDATED_EVENT, emitTagsUpdated } from "@/lib/tags";
import { emitBundlesUpdated } from "@/lib/bundles";
import { useMediaDetail } from "@/hooks/media/useMediaDetail";
import { MediaPreviewCard } from "@/components/media/MediaPreviewCard";
import { MediaInfoCard } from "@/components/media/MediaInfoCard";
import { MediaTextPanel } from "@/components/media/MediaTextPanel";
import { TagEditor } from "@/components/media/TagEditor";
import { MediaMetadataCard } from "@/components/media/MediaMetadataCard";
import { MediaBundlesPanel } from "@/components/media/MediaBundlesPanel";
import { MediaRemindersPanel } from "@/components/media/MediaRemindersPanel";
import MediaDetailSplit from "@/components/media/MediaDetailSplit";
import { useGroupRef } from "react-resizable-panels";
import { ConfirmPopover } from "@/components/ui/ConfirmPopover";

function MessageCard(props: {
  heading: string;
  body: string;
  actionLabel?: string;
  onAction?: () => void;
  actionVariant?: "default" | "outline";
}) {
  const { heading, body, actionLabel, onAction, actionVariant = "default" } = props;
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
        <div className="text-lg font-semibold">{heading}</div>
        <p className="max-w-md text-sm text-muted-foreground">{body}</p>
        {actionLabel && onAction && (
          <Button variant={actionVariant} onClick={onAction}>
            {actionLabel}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

export default function MediaDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { id } = use(params);

  const searchQuery = searchParams.get("q") ?? searchParams.get("search") ?? "";
  const highlightTerms = useMemo(() => parseSearchTerms(searchQuery), [searchQuery]);

  const {
    loadState,
    media,
    setMedia,
    document,
    metadata,
    thumbnailUrl,
    downloadUrl,
    setErrorMessage,
    errorMessage,
    refresh,
    fetchDownloadUrl,
    updateTitle,
    updateTags,
  } = useMediaDetail(id);

  const [isDeleting, setIsDeleting] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [isUnpacking, setIsUnpacking] = useState(false);
  const [confirmState, setConfirmState] = useState<{ x: number; y: number } | null>(null);

  const [prevId, setPrevId] = useState<string | null>(null);
  const [nextId, setNextId] = useState<string | null>(null);
  const [navQuery, setNavQuery] = useState("");

  const [thumbHeight, setThumbHeight] = useState<number | null>(null);
  const thumbHeightRef = useRef<number | null>(null);
  thumbHeightRef.current = thumbHeight;
  const thumbContainerRef = useRef<HTMLDivElement>(null);
  const snapHeightRef = useRef<number | null>(null);
  // Set when the image loads: min(naturalCardHeight, 75% viewport).
  // Prevents the drag bar from going below a height the image can't actually display at.
  const maxHeightRef = useRef<number>(0);
  // Imperative handle for the left/right panel group — used to link horizontal panel
  // width to vertical thumb height so both expand together.
  const panelGroupRef = useGroupRef();

  // Called by MediaPreviewCard when the image's natural dimensions are known.
  // Reads the actual rendered card height (after CSS) and uses it as the drag ceiling.
  // For tall images whose natural height exceeds the viewport limit, immediately enters
  // fill mode at the max so the user is never stuck below their starting position.
  const handleNaturalDims = useCallback(() => {
    requestAnimationFrame(() => {
      if (thumbHeightRef.current !== null) return; // already in fill mode
      const naturalCardHeight = thumbContainerRef.current?.offsetHeight ?? 0;
      const viewportMax = Math.round(window.innerHeight * 0.75);
      const max = Math.min(naturalCardHeight, viewportMax);
      maxHeightRef.current = max;
      if (naturalCardHeight > viewportMax) {
        setThumbHeight(viewportMax);
        snapHeightRef.current = viewportMax;
      }
    });
  }, []);

  const handleThumbSeparatorMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const naturalHeight = thumbContainerRef.current?.offsetHeight ?? 300;
    const startHeight = thumbHeightRef.current ?? naturalHeight;

    // Record the natural height once so we can snap back to it
    if (snapHeightRef.current === null) {
      snapHeightRef.current = naturalHeight;
    }

    setThumbHeight(startHeight);

    const SNAP_ZONE = 18;
    const MIN_HEIGHT = 120;
    const MAX_HEIGHT = Math.round(window.innerHeight * 0.75);
    // Left panel percentages: MIN when thumb is shortest, DEFAULT at natural/snap height,
    // MAX when thumb is at its tallest. All three are sampled by the continuous mapping below.
    const MIN_LEFT_PCT = 50;
    const DEFAULT_LEFT_PCT = 62;
    const MAX_LEFT_PCT = 78;
    const snap = snapHeightRef.current;
    const compute = (clientY: number) => {
      const raw = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, startHeight + clientY - startY));
      return snap !== null && Math.abs(raw - snap) <= SNAP_ZONE ? snap : raw;
    };

    // Returns the left panel percentage that corresponds to a given thumb height.
    // Piecewise-linear, continuous at snap: below snap contracts, above snap expands.
    const leftPctFor = (h: number) => {
      if (snap === null || snap <= MIN_HEIGHT) return DEFAULT_LEFT_PCT;
      if (h <= snap) {
        const t = Math.max(0, (h - MIN_HEIGHT) / (snap - MIN_HEIGHT));
        return MIN_LEFT_PCT + (DEFAULT_LEFT_PCT - MIN_LEFT_PCT) * t;
      }
      const t = Math.min(1, (h - snap) / (MAX_HEIGHT - snap));
      return DEFAULT_LEFT_PCT + (MAX_LEFT_PCT - DEFAULT_LEFT_PCT) * t;
    };

    // Capture the panel's actual current position so the first mousemove never teleports.
    // The offset is the gap between where the panel actually is vs. where the formula
    // would put it for the current thumb height, and it stays constant for the whole drag.
    const initialLeft = panelGroupRef.current?.getLayout()?.left ?? DEFAULT_LEFT_PCT;
    const panelOffset = initialLeft - leftPctFor(startHeight);

    const onMouseMove = (ev: MouseEvent) => {
      const h = compute(ev.clientY);
      setThumbHeight(h);
      if (panelGroupRef.current) {
        const leftPct = Math.max(0, Math.min(100, leftPctFor(h) + panelOffset));
        panelGroupRef.current.setLayout({ left: leftPct, right: 100 - leftPct });
      }
    };
    const onMouseUp = () => {
      window.document.removeEventListener("mousemove", onMouseMove);
      window.document.removeEventListener("mouseup", onMouseUp);
    };

    window.document.addEventListener("mousemove", onMouseMove);
    window.document.addEventListener("mouseup", onMouseUp);
  }, [panelGroupRef]);

  const title = media?.title || media?.filename || "Media details";
  const busy = isDeleting || isDownloading || isUnpacking;
  useEffect(() => {
    const es = new EventSource("/api/media/events");

    es.onopen = () => {
      refresh({ silent: true });
    };

    es.onmessage = (e: MessageEvent<string>) => {
      try {
        const { mediaId, field, value } = JSON.parse(e.data) as {
          mediaId?: string;
          field?: "textState" | "thumbState" | "tagsUpdated";
          value?: string;
        };
        if (mediaId !== id || !field || !value) return;
        if (field === "tagsUpdated") {
          emitTagsUpdated();
          refresh({ silent: true });
          return;
        }
        setMedia((prev) => (prev ? { ...prev, [field]: value } : prev));
        refresh({ silent: true });
      } catch {
        // ignore malformed messages
      }
    };

    return () => es.close();
  }, [id, refresh, setMedia]);

  useEffect(() => {
    const handler = (event: Event) => {
      const deletedTag =
        event instanceof CustomEvent && typeof event.detail?.deletedTag === "string"
          ? event.detail.deletedTag
          : null;
      if (!deletedTag) return;
      setMedia(prev => {
        if (!prev?.tags?.includes(deletedTag)) return prev;
        return { ...prev, tags: prev.tags.filter(tag => tag !== deletedTag) };
      });
      refresh({ silent: true });
    };
    window.addEventListener(TAGS_UPDATED_EVENT, handler);
    return () => window.removeEventListener(TAGS_UPDATED_EVENT, handler);
  }, [refresh, setMedia]);

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem('library:navList');
      if (!raw) return;
      const { ids, q: storedQ } = JSON.parse(raw) as { ids: string[]; q: string };
      const idx = ids.indexOf(id);
      if (idx === -1) return;
      setPrevId(idx > 0 ? ids[idx - 1] : null);
      setNextId(idx < ids.length - 1 ? ids[idx + 1] : null);
      setNavQuery(storedQ);
    } catch {
      // ignore
    }
  }, [id]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
      if (e.key === 'ArrowLeft' && prevId) router.push((navQuery ? `/media/${prevId}?q=${encodeURIComponent(navQuery)}` : `/media/${prevId}`) as Route);
      if (e.key === 'ArrowRight' && nextId) router.push((navQuery ? `/media/${nextId}?q=${encodeURIComponent(navQuery)}` : `/media/${nextId}`) as Route);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [prevId, nextId, navQuery, router]);

  const handleDownload = async () => {
    if (busy) return;
    setIsDownloading(true);
    setErrorMessage(null);
    try {
      const url = await fetchDownloadUrl();
      window.open(url, "_blank", "noopener");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unable to download file.";
      setErrorMessage(msg);
    } finally {
      setIsDownloading(false);
    }
  };

const handleDelete = (e: React.MouseEvent) => {
    if (isDeleting) return;
    setConfirmState({ x: e.clientX, y: e.clientY });
  };

  const doDelete = async () => {
    setIsDeleting(true);
    setErrorMessage(null);

    try {
      const res = await fetch(`/api/media/${id}`, { method: "DELETE", credentials: "include" });
      if (!res.ok) {
        const msg = await readErrorMessage(res, "Failed to delete media.");
        setErrorMessage(msg);
        setIsDeleting(false);
        return;
      }
      emitTagsUpdated();
      emitBundlesUpdated();
      const libraryTarget: Route = searchQuery
        ? (`/library?q=${encodeURIComponent(searchQuery)}` as Route)
        : "/library";
      router.push(libraryTarget);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to delete media.";
      setErrorMessage(msg);
      setIsDeleting(false);
    }
  };

  const handleUnpackToBundle = async () => {
    if (busy) return;
    setIsUnpacking(true);
    setErrorMessage(null);
    try {
      const res = await fetch(`/api/media/${id}/unpack`, { method: "POST", credentials: "include" });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setErrorMessage(data?.error ?? "Failed to unpack archive.");
        return;
      }
      const { bundleId } = (await res.json()) as { bundleId: string };
      setMedia(prev => (prev ? { ...prev, linkedBundleId: bundleId } : prev));
      emitBundlesUpdated();
      emitTagsUpdated();
      refresh({ silent: true });
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Failed to unpack archive.");
    } finally {
      setIsUnpacking(false);
    }
  };

  const handleRegenerateThumbnail = async () => {
    if (busy) return;
    setErrorMessage(null);
    try {
      const res = await fetch(`/api/media/${id}/thumbnail/regenerate`, { method: "POST", credentials: "include" });
      if (!res.ok) {
        const msg = await readErrorMessage(res, "Failed to queue thumbnail regeneration.");
        setErrorMessage(msg);
        return;
      }
      setMedia(prev => prev ? { ...prev, thumbState: "PENDING" } : prev);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Failed to queue thumbnail regeneration.");
    }
  };

  const renderLoading = () => (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <Card>
        <CardContent className="p-4">
          <Skeleton className="mx-auto aspect-[4/3] w-1/2" />
        </CardContent>
      </Card>
      <Card>
        <CardContent className="space-y-3">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-4 w-24" />
        </CardContent>
      </Card>
    </div>
  );

  const navHref = (targetId: string) =>
    (navQuery ? `/media/${targetId}?q=${encodeURIComponent(navQuery)}` : `/media/${targetId}`) as Route;

  return (
    <>
      {prevId && (
        <Link
          href={navHref(prevId)}
          className="fixed left-72 top-1/2 -translate-y-1/2 hidden lg:flex items-center justify-center p-2 text-muted-foreground hover:text-foreground transition-colors"
          aria-label="Previous item"
        >
          <ChevronLeft className="h-10 w-10" />
        </Link>
      )}
      {nextId && (
        <Link
          href={navHref(nextId)}
          className="fixed right-72 top-1/2 -translate-y-1/2 hidden lg:flex items-center justify-center p-2 text-muted-foreground hover:text-foreground transition-colors"
          aria-label="Next item"
        >
          <ChevronRight className="h-10 w-10" />
        </Link>
      )}
      <Container className="pt-6 pb-64">
      <div className="mb-8 flex min-w-0 items-center gap-1.5 text-base">
        <Link
          href={searchQuery ? `/library?q=${encodeURIComponent(searchQuery)}` : "/library"}
          className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
        >
          Library
        </Link>
        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
        <span className="truncate font-medium">{title}</span>
      </div>

      {loadState === "loading" && renderLoading()}

      {loadState === "unauthorized" && (
        <MessageCard
          heading="Sign in required"
          body="Your session has expired. Please sign in again to view this media item."
          actionLabel="Go to sign in"
          onAction={() => router.push(`/auth?next=/media/${id}`)}
        />
      )}

      {loadState === "not-found" && (
        <MessageCard
          heading="Media not found"
          body="We could not find that media item. It may have been deleted or you may not have access."
          actionLabel="Back to overview"
          actionVariant="outline"
          onAction={() => router.push("/overview")}
        />
      )}

      {loadState === "error" && (
        <MessageCard
          heading="Unable to load media"
          body={errorMessage || "Something went wrong while loading this media item."}
          actionLabel="Retry"
          onAction={refresh}
        />
      )}

      {loadState === "ready" && errorMessage && (
        <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {errorMessage}
        </div>
      )}

      {loadState === "ready" && media && (
        <MediaDetailSplit
          groupRef={panelGroupRef}
          left={
            <div className="flex flex-col">
              <div ref={thumbContainerRef} className="shrink-0 mb-2">
                <MediaPreviewCard
                  thumbnailUrl={thumbnailUrl}
                  downloadUrl={downloadUrl}
                  mimeType={media.mimeType}
                  title={title}
                  thumbState={media.thumbState}
                  thumbHeight={thumbHeight}
                  onNaturalDims={handleNaturalDims}
                />
              </div>

              <div
                role="separator"
                aria-orientation="horizontal"
                className="relative flex h-2 cursor-row-resize flex-col items-center justify-center bg-transparent transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 shrink-0"
                onMouseDown={handleThumbSeparatorMouseDown}
              >
                <div className="h-px w-full bg-border" />
              </div>

              <div className="pt-4">
                <MediaTextPanel
                  id={id}
                  textState={media.textState}
                  textError={media.textError}
                  mimeType={media.mimeType}
                  document={document}
                  highlightTerms={highlightTerms}
                  refreshKey={0}
                  isDeleting={isDeleting}
                  onQueuedOcr={() => {
                    setMedia((prev) =>
                      prev ? { ...prev, textState: "PENDING" } : prev
                    );
                    refresh({ silent: true });
                  }}
                  onCancelledOcr={() => {
                    setMedia((prev) =>
                      prev ? { ...prev, textState: "ERROR" } : prev
                    );
                    refresh({ silent: true });
                  }}
                />
              </div>
            </div>
          }
          right={
            <div className="flex flex-col gap-4">
              <PanelCard title="Actions" storageKey="mediaDetails:actions">
                <MediaInfoCard
                  busy={busy}
                  onDownload={handleDownload}
                  onDelete={handleDelete}
                  onRegenerateThumbnail={handleRegenerateThumbnail}
                  onUnpackToBundle={handleUnpackToBundle}
                  mimeType={media.mimeType}
                  linkedBundleId={media.linkedBundleId ?? null}
                />
              </PanelCard>
              {media.memberBundles && media.memberBundles.length > 0 && (
                <PanelCard title="Bundles" storageKey="mediaDetails:bundles">
                  <MediaBundlesPanel
                    mediaId={id}
                    memberBundles={media.memberBundles}
                    disabled={busy}
                    onRemoved={() => refresh({ silent: true })}
                  />
                </PanelCard>
              )}
              {media.reminders && media.reminders.length > 0 && (
                <PanelCard title="Reminders" storageKey="mediaDetails:reminders">
                  <MediaRemindersPanel
                    reminders={media.reminders}
                    onUpdated={() => refresh({ silent: true })}
                  />
                </PanelCard>
              )}
              <PanelCard title="Tags" storageKey="mediaDetails:tags">
                <TagEditor
                  tags={media.tags ?? []}
                  onSave={updateTags}
                  disabled={busy}
                />
              </PanelCard>
              <PanelCard title="Metadata" storageKey="mediaDetails:metadata">
                <MediaMetadataCard
                  media={media}
                  metadata={metadata}
                  onSaveTitle={updateTitle}
                  busy={busy}
                />
              </PanelCard>
            </div>
          }
        />
      )}
      <ConfirmPopover
        open={confirmState !== null}
        x={confirmState?.x ?? 0}
        y={confirmState?.y ?? 0}
        message="Delete this media item? This cannot be undone."
        onConfirm={() => { setConfirmState(null); void doDelete(); }}
        onCancel={() => setConfirmState(null)}
      />
      </Container>
    </>
  );
}
