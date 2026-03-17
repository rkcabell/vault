"use client";

import { use, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { Container, PanelCard } from "@/components/common";
import { Button } from "@/components/ui/Button";
import { Card, CardContent } from "@/components/ui/Card";
import { Skeleton } from "@/components/ui/Skeleton";

import { parseSearchTerms, readErrorMessage } from "@/lib/media/utils";
import { TAGS_UPDATED_EVENT } from "@/lib/tags";
import { useMediaDetail } from "@/hooks/media/useMediaDetail";
import { MediaPreviewCard } from "@/components/media/MediaPreviewCard";
import { MediaInfoCard } from "@/components/media/MediaInfoCard";
import { MediaTextPanel } from "@/components/media/MediaTextPanel";
import { TagEditor } from "@/components/media/TagEditor";
import { MediaMetadataCard } from "@/components/media/MediaMetadataCard";
import MediaDetailSplit from "@/components/media/MediaDetailSplit";

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
  const [isEmailing, setIsEmailing] = useState(false);

  const title = media?.title || media?.filename || "Media details";
  const busy = isDeleting || isDownloading || isEmailing;
  useEffect(() => {
    const es = new EventSource("/api/media/events");

    es.onopen = () => {
      refresh({ silent: true });
    };

    es.onmessage = (e: MessageEvent<string>) => {
      try {
        const { mediaId, field, value } = JSON.parse(e.data) as {
          mediaId?: string;
          field?: "textState" | "thumbState";
          value?: string;
        };
        if (mediaId !== id || !field || !value) return;
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

  // Keep email short and synchronous; link to the Vault page (mail clients + URL length issues)
  const handleEmail = () => {
    if (busy) return;
    setIsEmailing(true);
    setErrorMessage(null);
    try {
      const subject = `Vault file: ${title}`;
      const pageLink = `${window.location.origin}/media/${id}`;
      const body = [`Here is a file from Vault.`, "", `Title: ${title}`, `Filename: ${media?.filename ?? "N/A"}`, `Link: ${pageLink}`].join("\n");
      window.location.assign(`mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unable to prepare email.";
      setErrorMessage(msg);
    } finally {
      setIsEmailing(false);
    }
  };

  const handleDelete = async () => {
    if (isDeleting) return;
    const confirmed = window.confirm("Delete this media item? This cannot be undone.");
    if (!confirmed) return;

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
      router.push("/overview?refresh=1");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to delete media.";
      setErrorMessage(msg);
      setIsDeleting(false);
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

  return (
    <Container className="py-6">
      <div className="mb-8 flex min-w-0 items-center gap-1.5 text-sm">
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
          left={
            <div className="flex flex-col gap-6">
              <MediaPreviewCard
                thumbnailUrl={thumbnailUrl}
                downloadUrl={downloadUrl}
                mimeType={media.mimeType}
                title={title}
                thumbState={media.thumbState}
              />
              <div className="pt-4">
                <MediaTextPanel
                  id={id}
                  textState={media.textState}
                  textError={media.textError}
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
                  onEmail={handleEmail}
                  onDelete={handleDelete}
                  onRegenerateThumbnail={handleRegenerateThumbnail}
                />
              </PanelCard>
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
    </Container>
  );
}
