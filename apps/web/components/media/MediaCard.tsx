//File: apps/web/components/media/MediaCard.tsx
"use client";

import type { Route } from "next";
import { useCallback, useEffect, useRef, useState, type SyntheticEvent } from "react";
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Archive, Ban, BookOpen, Check, CheckCircle2, Circle, Download, ExternalLink, File as FileIcon, FileText, Film, MoreVertical, Music, Pencil, Star, Trash2, type LucideIcon } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { cn } from '@/lib/utils';
import { ARCHIVE_MIME_TYPES, formatBytes } from '@/lib/media/utils';
import { orderTagsByOrigin, isAutoTagFromStore } from '@/lib/tags';
import { Button } from '@/ui/Button';
import { Input } from '@/ui/Input';
import { Badge } from '@/ui/Badge';
import type { MediaWorkerState } from '@/lib/media/types';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui/DropdownMenu';
import { Card, CardContent } from '@/ui/Card';


export interface MediaItem {
  id: string;
  title: string;
  filename?: string | null;
  thumbState: MediaWorkerState;
  textState: MediaWorkerState;
  tags?: string[];
  downloadUrl?: string;
  mimeType?: string | null;
  sizeBytes?: number | null;
  starred?: boolean;
  /** Resolved file date (EXIF/PDF/mtime) — powers the Year sort's dividers. */
  fileDate?: string | null;
  /** ISO date the source file was found to have vanished, or null while it is
   *  present. The item is kept — tags, title and all — because the file may
   *  simply have moved, so the card is dimmed rather than removed. */
  missingSince?: string | null;
}

interface MediaCardProps {
  media: MediaItem;
  variant?: 'grid' | 'list';
  className?: string;
  onDownload?: (id: string) => void;
  onRename?: (id: string, nextTitle: string) => void | Promise<void>;
  onDelete?: (id: string, e: React.MouseEvent) => void | Promise<void>;
  /** Called after the star toggle round-trips (mirrors BundleCard). */
  onStarToggle?: (id: string, next: boolean) => void;
  isDeleting?: boolean;
  loading?: "eager" | "lazy";
  density?: "comfortable" | "compact";
  isSelectMode?: boolean;
  isSelected?: boolean;
  onSelect?: (id: string, shiftKey: boolean) => void;
  gridCols?: number;
}


type FallbackKind = "image" | "pdf" | "file" | "audio" | "document" | "archive";

function getMediaTypeIcon (mimeType?: string | null): LucideIcon {
  if (!mimeType) return FileIcon;
  const m = mimeType.toLowerCase();
  if (m.startsWith("audio/")) return Music;
  if (m === "application/epub+zip") return BookOpen;
  if (m.startsWith("video/")) return Film;
  if (ARCHIVE_MIME_TYPES.has(m)) return Archive;
  if (
    m.startsWith("text/") ||
    m === "application/json" ||
    m.startsWith("application/vnd.oasis.opendocument") ||
    m === "application/pdf"
  ) return FileText;
  return FileIcon;
}

function getFallbackKind (mimeType?: string | null): FallbackKind {
  if (!mimeType) return "file";
  const m = mimeType.toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m === "application/pdf") return "pdf";
  if (m.startsWith("audio/")) return "audio";
  if (ARCHIVE_MIME_TYPES.has(m)) return "archive";
  if (
    m.startsWith("application/vnd.oasis.opendocument") ||
    m === "application/json" ||
    m === "application/epub+zip" ||
    m.startsWith("text/")
  ) return "document";
  return "file";
}




function getMimeTypeLabel(mimeType?: string | null, filename?: string | null): string {
  if (!mimeType) {
    if (filename) {
      const dot = filename.lastIndexOf(".");
      if (dot >= 0 && dot < filename.length - 1) return filename.slice(dot + 1).toUpperCase().slice(0, 8);
    }
    return "—";
  }
  const m = mimeType.toLowerCase();
  if (m === "image/jpeg" || m === "image/jpg") return "JPEG";
  if (m === "image/png") return "PNG";
  if (m === "image/gif") return "GIF";
  if (m === "image/webp") return "WebP";
  if (m === "image/heic" || m === "image/heif") return "HEIC";
  if (m === "image/svg+xml") return "SVG";
  if (m === "image/tiff") return "TIFF";
  if (m === "image/bmp") return "BMP";
  if (m === "video/mp4") return "MP4";
  if (m === "video/quicktime") return "MOV";
  if (m === "video/webm") return "WebM";
  if (m === "video/x-matroska") return "MKV";
  if (m === "video/x-msvideo") return "AVI";
  if (m.startsWith("audio/")) return "Audio";
  if (m === "application/pdf") return "PDF";
  if (m === "text/plain") return "Text";
  if (m === "text/html") return "HTML";
  if (m === "text/csv") return "CSV";
  if (m === "application/json") return "JSON";
  if (m === "application/epub+zip") return "EPUB";
  if (m === "application/msword") return "DOC";
  if (m === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return "DOCX";
  if (m === "application/vnd.ms-excel") return "XLS";
  if (m === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") return "XLSX";
  if (m === "application/vnd.ms-powerpoint") return "PPT";
  if (m === "application/vnd.openxmlformats-officedocument.presentationml.presentation") return "PPTX";
  if (m === "application/zip" || m === "application/x-zip-compressed") return "ZIP";
  if (m === "application/x-tar") return "TAR";
  if (m === "application/gzip" || m === "application/x-gzip") return "GZIP";
  if (m === "application/x-7z-compressed") return "7Z";
  if (m === "application/x-rar-compressed" || m === "application/vnd.rar") return "RAR";
  if (m === "application/octet-stream") {
    if (filename) {
      const dot = filename.lastIndexOf(".");
      if (dot >= 0 && dot < filename.length - 1) return filename.slice(dot + 1).toUpperCase().slice(0, 8);
    }
    return "Binary";
  }
  const sub = m.split("/")[1];
  return sub ? sub.toUpperCase().slice(0, 8) : "File";
}

// Shared layout constants for list variant — used by both MediaCard and MediaCardListHeader
// so column positions stay in sync when values change.
const LIST_THUMB_W = { comfortable: 'w-24', compact: 'w-20' } as const;
const LIST_INNER_GAP = { comfortable: 'gap-3', compact: 'gap-2' } as const;
const LIST_TYPE_W = 'w-20' as const;
const LIST_SIZE_W = 'w-12' as const;

export function MediaCard({
  media,
  variant = 'grid',
  className,
  onDownload,
  onRename,
  onDelete,
  onStarToggle,
  isDeleting = false,
  loading = "lazy",
  density = "comfortable",
  isSelectMode = false,
  isSelected = false,
  onSelect,
  gridCols,
}: MediaCardProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  // The file is gone from disk but the item is deliberately kept, because a
  // move looks exactly like a delete until the file turns up somewhere else.
  const isMissing = !!media?.missingSince;
  const id = media?.id;
  const q = searchParams.get("q") ?? searchParams.get("search");
  const mediaHref = (id ? `/media/${id}` : "/media") as Route;
  const hrefWithQuery =  id && q ? (`/media/${id}?q=${encodeURIComponent(q)}` as Route) : mediaHref;
  // FAILED = real render failure, UNSUPPORTED = never thumbnailable — both show the
  // media-type fallback icon instead of a broken/stuck image.
  const thumbError =
    media.thumbState === "ERROR" || media.thumbState === "FAILED" || media.thumbState === "UNSUPPORTED";
  const fallbackKind = getFallbackKind(media.mimeType);
  const thumbVersion = media.thumbState === "READY" ? "ready" : "pending";
  const thumbnailSrc = `/api/media/${media.id}/thumbnail?v=${thumbVersion}`;
  const MediaTypeIcon = getMediaTypeIcon(media.mimeType);
  const isCompact = density === "compact";
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(media.title);
  const [isSavingRename, setIsSavingRename] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const ignoreBlurRef = useRef(false);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [titleOverflows, setTitleOverflows] = useState(false);

  useEffect(() => {
    if (gridCols !== 4 || variant !== 'grid') return;
    const el = titleRef.current;
    if (!el) return;
    setTitleOverflows(el.scrollWidth > el.clientWidth);
  }, [media.title, gridCols, variant]);

  useEffect(() => {
    if (!isRenaming) {
      setRenameValue(media.title);
    }
  }, [isRenaming, media.title]);

  useEffect(() => {
    if (!isRenaming) return;
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    const end = input.value.length;
    input.setSelectionRange(end, end);
  }, [isRenaming]);

  const startRename = () => {
    if (!onRename || isDeleting) return;
    setRenameValue(media.title);
    setIsRenaming(true);
  };

  const cancelRename = () => {
    setRenameValue(media.title);
    setIsRenaming(false);
  };

  const commitRename = async () => {
    if (!onRename) {
      cancelRename();
      return;
    }
    const trimmed = renameValue.trim();
    if (!trimmed) {
      cancelRename();
      return;
    }
    if (trimmed === media.title.trim()) {
      setIsRenaming(false);
      return;
    }
    setIsSavingRename(true);
    try {
      await onRename(media.id, trimmed);
      setIsRenaming(false);
    } finally {
      setIsSavingRename(false);
    }
  };

  const handleRenameKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void commitRename();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      ignoreBlurRef.current = true;
      cancelRename();
    }
  };

  const handleRenameBlur = () => {
    if (ignoreBlurRef.current) {
      ignoreBlurRef.current = false;
      return;
    }
    void commitRename();
  };

  const handleThumbError = useCallback(
    (event: SyntheticEvent<HTMLImageElement>) => {
      const img = event.currentTarget;
      if (img.dataset.fallbackApplied === "true") return;
      img.dataset.fallbackApplied = "true";
      img.src = `/thumbnails/fallback?kind=${fallbackKind}`;
    },
    [fallbackKind],
  );

  const handleDownload = (e: React.MouseEvent) => {
    e.preventDefault();
    onDownload?.(media.id);
  };

  const [isStarring, setIsStarring] = useState(false);
  const handleStar = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (isStarring) return;
    setIsStarring(true);
    try {
      const res = await apiFetch(`/api/media/${media.id}/star`, {
        method: "POST",
        credentials: "include",
      });
      if (res.ok) {
        const data = (await res.json()) as { starred: boolean };
        onStarToggle?.(media.id, data.starred);
      }
    } finally {
      setIsStarring(false);
    }
  };

  const triggerDelete = (e?: React.MouseEvent) => {
    e?.preventDefault();
    e?.stopPropagation();
    if (!onDelete || isDeleting || !e) return;
    void onDelete(media.id, e);
  };

  const triggerRename = (e?: React.MouseEvent) => {
    e?.preventDefault();
    e?.stopPropagation();
    startRename();
  };

  const handleSelectClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onSelect?.(media.id, e.shiftKey);
  };

  const handleInfoAreaClick = (event: React.MouseEvent<HTMLElement>) => {
    if (isSelectMode || isRenaming) return;
    const target = event.target as HTMLElement | null;
    if (!target) return;
    if (target.closest("a,button,input,textarea,select,[role='menuitem']")) return;
    router.push(hrefWithQuery);
  };

  if (variant === 'list') {
    return (
      <Card
        className={cn('rounded-none shadow-none bg-transparent border-0 border-b border-border/40 hover:bg-muted/50 transition-colors', isSelectMode && 'cursor-pointer select-none', isMissing && 'opacity-60', className)}
        style={isSelectMode && isSelected ? { outline: '2px solid var(--color-selection, #06b6d4)', outlineOffset: '0px' } : undefined}
        onClick={isSelectMode ? handleSelectClick : undefined}
      >
        <CardContent className={cn("py-2 px-4", isCompact && "py-1.5 px-3")}>
          <div className={cn("flex items-center gap-4", isCompact && "gap-2")}>

            {/* Selection circle (list) */}
            {isSelectMode && (
              <button
                type="button"
                aria-label={isSelected ? "Deselect" : "Select"}
                onClick={handleSelectClick}
                className="flex-shrink-0 p-0.5"
              >
                {isSelected
                  ? <CheckCircle2 className="h-6 w-6 stroke-white" style={{ color: "var(--color-selection, #06b6d4)", fill: "var(--color-selection, #06b6d4)" }} />
                  : <Circle className="h-6 w-6 text-muted-foreground" />
                }
              </button>
            )}

            {/* Thumbnail */}
            {isSelectMode ? (
              <div
                className={cn(
                  "relative aspect-[4/3] flex-shrink-0 cursor-pointer overflow-hidden rounded-md bg-muted",
                  isCompact ? `h-12 ${LIST_THUMB_W.compact}` : `h-16 ${LIST_THUMB_W.comfortable}`,
                )}
                onClick={handleSelectClick}
              >
                {thumbError ? (
                  <div className="flex h-full w-full items-center justify-center">
                    <MediaTypeIcon className="h-8 w-8 text-muted-foreground" />
                  </div>
                ) : (
                  <img
                    key={`${media.id}-${thumbVersion}-list`}
                    src={thumbnailSrc}
                    alt={media.title}
                    className="h-full w-full object-cover object-center"
                    loading={loading}
                    onError={handleThumbError}
                  />
                )}
              </div>
            ) : (
              <Link href={hrefWithQuery} className="flex-shrink-0 items-center">
                <div
                  className={cn(
                    "relative aspect-[4/3] overflow-hidden rounded-md bg-muted",
                    isCompact ? `h-12 ${LIST_THUMB_W.compact}` : `h-16 ${LIST_THUMB_W.comfortable}`,
                  )}
                >
                  {thumbError ? (
                    <div className="flex h-full w-full items-center justify-center">
                      <MediaTypeIcon className="h-8 w-8 text-muted-foreground" />
                    </div>
                  ) : (
                    <img
                      key={`${media.id}-${thumbVersion}-list`}
                      src={thumbnailSrc}
                      alt={media.title}
                      className="h-full w-full object-cover object-center"
                      loading={loading}
                      onError={handleThumbError}
                    />
                  )}
                </div>
              </Link>
            )}

            <div className="flex-1 min-w-0 cursor-pointer" onClick={handleInfoAreaClick}>
              <div className={cn("flex items-center min-w-0", isCompact ? LIST_INNER_GAP.compact : LIST_INNER_GAP.comfortable)}>
                <div className="flex-1 min-w-0">
                  {isRenaming ? (
                    <div className={cn("flex items-center gap-2", isCompact && "gap-1")}>
                      <Input
                        ref={inputRef}
                        value={renameValue}
                        onChange={(event) => setRenameValue(event.target.value)}
                        onKeyDown={handleRenameKeyDown}
                        onBlur={handleRenameBlur}
                        disabled={isSavingRename || isDeleting}
                        className={cn("h-8 px-2 w-auto flex-1", isCompact && "h-7")}
                        aria-label="Rename title"
                      />
                      <Button
                        variant="outline"
                        size="icon"
                        onMouseDown={() => { ignoreBlurRef.current = true; }}
                        onClick={() => { void commitRename(); }}
                        disabled={isSavingRename || isDeleting}
                        aria-label="Save rename"
                        className={cn("h-8 w-8", isCompact && "h-7 w-7")}
                      >
                        <Check className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="outline"
                        size="icon"
                        onMouseDown={() => { ignoreBlurRef.current = true; }}
                        onClick={() => { cancelRename(); }}
                        disabled={isSavingRename || isDeleting}
                        aria-label="Cancel rename"
                        className={cn("h-8 w-8", isCompact && "h-7 w-7")}
                      >
                        <Ban className="h-4 w-4" />
                      </Button>
                    </div>
                  ) : isSelectMode ? (
                    <button type="button" onClick={handleSelectClick} className="text-left w-full">
                      <h3 className="truncate font-medium">{media.title}</h3>
                    </button>
                  ) : (
                    <Link
                      href={hrefWithQuery}
                      className="font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
                    >
                      <h3 className="truncate">{media.title}</h3>
                    </Link>
                  )}
                </div>
                {!isRenaming && isMissing && (
                  <Badge
                    variant="outline"
                    className="shrink-0 gap-1 text-xs"
                    title="This file is no longer at its indexed location. Vault keeps the item in case it was moved."
                  >
                    <Ban className="h-3 w-3" aria-hidden />
                    Missing
                  </Badge>
                )}
                {!isRenaming && (
                  <>
                    {media.starred && (
                      <Star
                        className="h-3.5 w-3.5 shrink-0"
                        style={{ fill: "var(--color-star, #fbbf24)", color: "var(--color-star, #fbbf24)" }}
                        aria-label="Starred"
                      />
                    )}
                    <span className={cn(LIST_TYPE_W, "shrink-0 flex items-center")}>
                      <span className="overview-type-badge">{getMimeTypeLabel(media.mimeType, media.filename)}</span>
                    </span>
                    <span className={cn(LIST_SIZE_W, "shrink-0 text-xs text-muted-foreground text-right tabular-nums")}>
                      {media.sizeBytes != null ? formatBytes(media.sizeBytes) : "—"}
                    </span>
                  </>
                )}
              </div>
              </div>

            <div className={cn("flex items-center gap-2", isCompact && "gap-1")}>
              {!isSelectMode && (
                <DropdownMenu modal={false}>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" aria-label="More actions">
                      <MoreVertical className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-[10rem]">
                    <DropdownMenuItem asChild>
                      <Link href={hrefWithQuery} className='flex w-full items-center gap-2'>
                        <ExternalLink className="mr-2 h-4 w-4 shrink-0" />
                        <span className="whitespace-nowrap">Open Details</span>
                      </Link>
                    </DropdownMenuItem>
                    {onStarToggle && (
                      <DropdownMenuItem onClick={(e) => { void handleStar(e); }} disabled={isStarring}>
                        <Star className="mr-2 h-4 w-4 shrink-0" />
                        {media.starred ? "Unstar" : "Star"}
                      </DropdownMenuItem>
                    )}
                    {onRename && (
                      <DropdownMenuItem onClick={triggerRename}>
                        <Pencil className="mr-2 h-4 w-4 shrink-0" />
                        Rename
                      </DropdownMenuItem>
                    )}
                    {onDownload && (
                      <DropdownMenuItem onClick={handleDownload}>
                        <Download className="mr-2 h-4 w-4 shrink-0" />
                        Download
                      </DropdownMenuItem>
                    )}
                    {onDelete && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={triggerDelete}
                        >
                          <Trash2 className="mr-2 h-4 w-4 shrink-0" />
                          {isDeleting ? 'Deleting...' : 'Delete'}
                        </DropdownMenuItem>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card
      className={cn('group flex flex-col overflow-hidden hover:shadow-lg transition-shadow', isSelectMode && 'select-none', isMissing && 'opacity-60', className)}
      style={isSelectMode && isSelected ? { outline: '2px solid var(--color-selection, #06b6d4)', outlineOffset: '0px' } : undefined}
    >
      {isSelectMode ? (
        <div
          className={cn("block cursor-pointer relative w-full overflow-hidden bg-muted media-item shrink-0", isCompact ? "aspect-square" : "aspect-[4/3]")}
          onClick={handleSelectClick}
        >
          {thumbError ? (
            <div className="flex h-full w-full items-center justify-center">
              <MediaTypeIcon className="h-12 w-12 text-muted-foreground" />
            </div>
          ) : (
            <img
              key={`${media.id}-${thumbVersion}-grid`}
              src={thumbnailSrc}
              alt={media.title}
              className="media-item__img h-full w-full object-cover transition-transform duration-300 ease-out group-hover:scale-105"
              loading={loading}
              onError={handleThumbError}
            />
          )}
          {/* Selection circle overlay */}
          <button
            type="button"
            aria-label={isSelected ? "Deselect" : "Select"}
            onClick={handleSelectClick}
            className="absolute top-2 left-2 z-10"
          >
            {isSelected
              ? <CheckCircle2 className="h-6 w-6 text-white drop-shadow" style={{ fill: "var(--color-selection, #06b6d4)" }} />
              : <Circle className="h-6 w-6 text-white drop-shadow" />
            }
          </button>
        </div>
      ) : (
        <Link href={hrefWithQuery} className="block cursor-pointer">
          <div className={cn("relative w-full overflow-hidden bg-muted media-item shrink-0", isCompact ? "aspect-square" : "aspect-[4/3]")}>
            {thumbError ? (
              <div className="flex h-full w-full items-center justify-center">
                <MediaTypeIcon className="h-12 w-12 text-muted-foreground" />
              </div>
            ) : (
              <img
                key={`${media.id}-${thumbVersion}-grid`}
                src={thumbnailSrc}
                alt={media.title}
                className="media-item__img h-full w-full object-cover transition-transform duration-300 ease-out group-hover:scale-105"
                loading={loading}
                onError={handleThumbError}
              />
            )}
            {/* Star — top-left overlay (mirrors BundleCard). Always visible when
                starred; appears on hover otherwise. */}
            {onStarToggle && (
              <button
                onClick={(e) => { void handleStar(e); }}
                disabled={isStarring}
                aria-label={media.starred ? "Unstar" : "Star"}
                className={cn(
                  "absolute top-1 left-1 z-10 p-1.5 text-white drop-shadow transition-all disabled:opacity-50",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-md",
                  media.starred ? "opacity-100" : "opacity-0 group-hover:opacity-100 hover:scale-110",
                )}
              >
                <Star
                  className="h-5 w-5"
                  style={media.starred ? { fill: "var(--color-star, #fbbf24)", color: "var(--color-star, #fbbf24)" } : undefined}
                />
              </button>
            )}
            {isMissing && (
              <span
                title="This file is no longer at its indexed location. Vault keeps the item in case it was moved."
                className="absolute bottom-1 right-1 z-10 flex items-center gap-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] leading-none text-white"
              >
                <Ban className="h-3 w-3" aria-hidden />
                Missing
              </span>
            )}
          </div>
        </Link>
      )}

      <CardContent
        className={cn("flex flex-col gap-1 px-2 py-2", isCompact && "gap-0 px-1 py-0.5")}
        onClick={handleInfoAreaClick}
      >
        <div className={cn("flex items-center gap-1", isCompact && "gap-0.5")}>
          <div className="min-w-0 flex-1">
            {isRenaming ? (
              <div className="flex items-center gap-2">
                <Input
                  ref={inputRef}
                  value={renameValue}
                  onChange={(event) => setRenameValue(event.target.value)}
                  onKeyDown={handleRenameKeyDown}
                  onBlur={handleRenameBlur}
                  disabled={isSavingRename || isDeleting}
                  className="h-8 flex-1 px-2"
                  aria-label="Rename title"
                />
                <Button
                  variant="outline"
                  size="icon"
                  onMouseDown={() => { ignoreBlurRef.current = true; }}
                  onClick={() => { void commitRename(); }}
                  disabled={isSavingRename || isDeleting}
                  aria-label="Save rename"
                  className="h-8 w-8 shrink-0"
                >
                  <Check className="h-4 w-4" />
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  onMouseDown={() => { ignoreBlurRef.current = true; }}
                  onClick={() => { cancelRename(); }}
                  disabled={isSavingRename || isDeleting}
                  aria-label="Cancel rename"
                  className="h-8 w-8 shrink-0"
                >
                  <Ban className="h-4 w-4" />
                </Button>
              </div>
            ) : isSelectMode ? (
              <button
                type="button"
                onClick={handleSelectClick}
                className="text-left w-full"
              >
                <h3 ref={titleRef} className={cn("media-card__title font-medium", isCompact ? "text-xs leading-tight line-clamp-2" : "truncate", titleOverflows && "text-xs")}>{media.title}</h3>
              </button>
            ) : (
              <Link
                href={hrefWithQuery}
                className="font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
              >
                <h3 ref={titleRef} className={cn("media-card__title", isCompact ? "text-xs leading-tight line-clamp-2" : "truncate", titleOverflows && "text-xs")}>{media.title}</h3>
              </Link>
            )}
          </div>

          {!isRenaming && !isSelectMode && !isCompact && (
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="More actions"
                  className="h-7 w-7 shrink-0 text-muted-foreground"
                >
                  <MoreVertical className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[10rem]">
                <DropdownMenuItem asChild>
                  <Link href={hrefWithQuery} className='flex w-full items-center gap-2'>
                    <ExternalLink className="mr-2 h-4 w-4 shrink-0" />
                    Open
                  </Link>
                </DropdownMenuItem>
                {onStarToggle && (
                  <DropdownMenuItem onClick={(e) => { void handleStar(e); }} disabled={isStarring}>
                    <Star className="mr-2 h-4 w-4 shrink-0" />
                    {media.starred ? "Unstar" : "Star"}
                  </DropdownMenuItem>
                )}
                {onRename && (
                  <DropdownMenuItem onClick={triggerRename}>
                    <Pencil className="mr-2 h-4 w-4 shrink-0" />
                    Rename
                  </DropdownMenuItem>
                )}
                {onDownload && (
                  <DropdownMenuItem onClick={handleDownload}>
                    <Download className="mr-2 h-4 w-4 shrink-0" />
                    Download
                  </DropdownMenuItem>
                )}
                {onDelete && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={triggerDelete}
                    >
                      <Trash2 className="mr-2 h-4 w-4 shrink-0" />
                      {isDeleting ? 'Deleting...' : 'Delete'}
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        {!isCompact && ((media.tags && media.tags.length > 0) || media.sizeBytes != null) && (
          <div className="flex items-center justify-between gap-1">
            <div className="flex flex-wrap gap-1">
              {orderTagsByOrigin(media.tags ?? [], isAutoTagFromStore).slice(0, 1).map((tag) => (
                <Badge
                  key={tag}
                  variant={isAutoTagFromStore(tag) ? "auto" : "user"}
                  className="text-xs max-w-[10rem]"
                >
                  <span className="truncate">{tag}</span>
                </Badge>
              ))}
              {media.tags && media.tags.length > 1 && (
                <Badge variant="outline" className="text-xs">
                  +{media.tags.length - 1}
                </Badge>
              )}
            </div>
            {media.sizeBytes != null && (
              <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground tabular-nums">
                {formatBytes(media.sizeBytes)}
              </span>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function MediaCardListHeader({
  density = "comfortable",
  isSelectMode = false,
}: {
  density?: "comfortable" | "compact";
  isSelectMode?: boolean;
}) {
  const isCompact = density === "compact";
  return (
    <Card
      className="rounded-none shadow-none bg-transparent border-0 border-b border-border select-none"
    >
      <CardContent className={cn("py-2 px-4", isCompact && "py-1.5 px-3")}>
        <div className={cn("flex items-center text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground", isCompact ? "gap-2" : "gap-4")}>
          {/* Selection circle placeholder */}
          {isSelectMode && (
            <div className="flex-shrink-0 p-0.5" aria-hidden>
              <div className="h-6 w-6" />
            </div>
          )}
          {/* Thumbnail placeholder — invisible, keeps column alignment */}
          <div
            className={cn(
              "flex-shrink-0 self-stretch",
              isCompact ? LIST_THUMB_W.compact : LIST_THUMB_W.comfortable,
            )}
            aria-hidden
          />
          {/* Columns — mirrors: div.flex-1.min-w-0 > div.flex.items-center.min-w-0 */}
          <div className="flex-1 min-w-0">
            <div className={cn("flex items-center min-w-0", isCompact ? LIST_INNER_GAP.compact : LIST_INNER_GAP.comfortable)}>
              <div className="flex-1">Title</div>
              <span className={cn(LIST_TYPE_W, "shrink-0")}>Type</span>
              <span className={cn(LIST_SIZE_W, "shrink-0 text-right")}>Size</span>
            </div>
          </div>
          {/* Actions placeholder */}
          <div className={cn("flex items-center", isCompact ? "gap-1" : "gap-2")}>
            {!isSelectMode && <div className="h-10 w-10" aria-hidden />}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
