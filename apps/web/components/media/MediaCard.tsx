//File: apps/web/components/media/MediaCard.tsx
"use client";

import type { Route } from "next";
import { useCallback, useEffect, useRef, useState, type SyntheticEvent } from "react";
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Archive, Ban, BookOpen, Check, CheckCircle2, Circle, Download, ExternalLink, File as FileIcon, FileText, Film, MoreVertical, Music, Pencil, Trash2, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
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
  thumbState: MediaWorkerState;
  textState: MediaWorkerState;
  tags?: string[];
  downloadUrl?: string;
  mimeType?: string | null;
}

interface MediaCardProps {
  media: MediaItem;
  variant?: 'grid' | 'list';
  className?: string;
  onDownload?: (id: string) => void;
  onRename?: (id: string, nextTitle: string) => void | Promise<void>;
  onDelete?: (id: string, e: React.MouseEvent) => void | Promise<void>;
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
  if (
    m === "application/zip" ||
    m === "application/x-zip-compressed" ||
    m === "application/x-7z-compressed" ||
    m === "application/x-rar-compressed" ||
    m === "application/vnd.rar"
  ) return Archive;
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
  if (
    m === "application/zip" ||
    m === "application/x-zip-compressed" ||
    m === "application/x-7z-compressed" ||
    m === "application/x-rar-compressed" ||
    m === "application/vnd.rar"
  ) return "archive";
  if (
    m.startsWith("application/vnd.oasis.opendocument") ||
    m === "application/json" ||
    m === "application/epub+zip" ||
    m.startsWith("text/")
  ) return "document";
  return "file";
}



export function MediaCard({
  media,
  variant = 'grid',
  className,
  onDownload,
  onRename,
  onDelete,
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
  const id = media?.id;
  const q = searchParams.get("q") ?? searchParams.get("search");
  const mediaHref = (id ? `/media/${id}` : "/media") as Route;
  const hrefWithQuery =  id && q ? (`/media/${id}?q=${encodeURIComponent(q)}` as Route) : mediaHref;
  const thumbError = media.thumbState === "ERROR" || media.thumbState === "FAILED";
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
        className={cn('hover:bg-accent/50 transition-colors', className)}
        style={isSelectMode && isSelected ? { outline: '2px solid #06b6d4', outlineOffset: '0px' } : undefined}
      >
        <CardContent className={cn("p-4", isCompact && "px-2 py-1")}>
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
                  ? <CheckCircle2 className="h-6 w-6 text-cyan-500 fill-cyan-500 stroke-white" />
                  : <Circle className="h-6 w-6 text-muted-foreground" />
                }
              </button>
            )}

            {/* Thumbnail */}
            {isSelectMode ? (
              <div
                className={cn(
                  "relative aspect-[4/3] h-16 w-24 flex-shrink-0 cursor-pointer overflow-hidden rounded-md bg-muted",
                  isCompact && "h-12 w-20",
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
                    "relative aspect-[4/3] h-16 w-24 overflow-hidden rounded-md bg-muted",
                    isCompact && "h-12 w-20",
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
                    onMouseDown={() => {
                      ignoreBlurRef.current = true;
                    }}
                    onClick={() => {
                      void commitRename();
                    }}
                    disabled={isSavingRename || isDeleting}
                    aria-label="Save rename"
                    className={cn("h-8 w-8", isCompact && "h-7 w-7")}
                  >
                    <Check className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    onMouseDown={() => {
                      ignoreBlurRef.current = true;
                    }}
                    onClick={() => {
                      cancelRename();
                    }}
                    disabled={isSavingRename || isDeleting}
                    aria-label="Cancel rename"
                    className={cn("h-8 w-8", isCompact && "h-7 w-7")}
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
              {media.tags && media.tags.length > 0 && (
                <div className={cn("mt-1 flex flex-wrap gap-1", isCompact && "mt-0.5")}>
                  {media.tags.slice(0, 1).map((tag) => (
                    <Badge key={tag} variant="outline" className="text-xs max-w-[10rem]">
                      <span className="truncate">{tag}</span>
                    </Badge>
                  ))}
                  {media.tags.length > 1 && (
                    <Badge variant="outline" className="text-xs">
                      +{media.tags.length - 1}
                    </Badge>
                  )}
                </div>
              )}
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
      className={cn('group flex flex-col overflow-hidden hover:shadow-lg transition-shadow', className)}
      style={isSelectMode && isSelected ? { outline: '2px solid #06b6d4', outlineOffset: '0px' } : undefined}
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
              ? <CheckCircle2 className="h-6 w-6 text-white fill-blue-500 drop-shadow" />
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

        {!isCompact && media.tags && media.tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {media.tags.slice(0, 1).map((tag) => (
              <Badge key={tag} variant="outline" className="text-xs max-w-[10rem]">
                <span className="truncate">{tag}</span>
              </Badge>
            ))}
            {media.tags.length > 1 && (
              <Badge variant="outline" className="text-xs">
                +{media.tags.length - 1}
              </Badge>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
