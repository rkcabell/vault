'use client'

import { useCallback, useEffect, useRef, createElement, useMemo, useState, type SyntheticEvent } from "react";
import { Archive, BookOpen, File as FileIcon, FileText, Film, Music, type LucideIcon } from "lucide-react";
import { Card, CardContent } from "@/components/ui/Card";
import { Skeleton } from "@/components/ui/Skeleton";

// These constants mirror the CSS padding classes used below.
// CardContent uses p-4 (16px per side = 32px total per axis).
// preview-mat uses p-2 (8px per side = 16px total per axis).
const CARD_CONTENT_PAD = 32;
const MAT_PAD = 16;

function getMediaTypeIcon(mimeType?: string | null): LucideIcon {
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

export function MediaPreviewCard(props: {
  thumbnailUrl: string | null;
  downloadUrl?: string | null;
  mimeType?: string | null;
  title: string;
  thumbState?: string | null;
  thumbHeight?: number | null;
  onNaturalDims?: (dims: { w: number; h: number }) => void;
}) {
  const { thumbnailUrl, downloadUrl, mimeType, title, thumbState, thumbHeight, onNaturalDims } = props;
  const [naturalDims, setNaturalDims] = useState<{ w: number; h: number } | null>(null);
  const [contentWidth, setContentWidth] = useState<number | null>(null);
  const cardContentRef = useRef<HTMLDivElement>(null);
  const thumbError = thumbState === "ERROR" || thumbState === "FAILED";
  const mediaTypeIcon = getMediaTypeIcon(mimeType);
  const isFill = thumbHeight != null;

  // Track CardContent width so fill-mode mat sizing reacts to panel resize.
  useEffect(() => {
    const el = cardContentRef.current;
    if (!el) return;
    const observer = new ResizeObserver(entries => {
      setContentWidth(entries[0]?.contentRect.width ?? null);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // In fill mode, compute explicit mat pixel dimensions so the mat hugs the image
  // at whatever size fits inside the card, without relying on CSS aspect-ratio
  // (which squishes when an explicit width and a max-height constraint conflict).
  const matStyle = useMemo<React.CSSProperties | undefined>(() => {
    if (!isFill || !naturalDims || thumbHeight == null || !contentWidth) return undefined;
    const availW = contentWidth - MAT_PAD;
    const availH = thumbHeight - CARD_CONTENT_PAD - MAT_PAD;
    if (availW <= 0 || availH <= 0) return undefined;
    const scale = Math.min(availW / naturalDims.w, availH / naturalDims.h);
    const imgW = Math.floor(naturalDims.w * scale);
    const imgH = Math.floor(naturalDims.h * scale);
    // +MAT_PAD so the style sets the border-box size (Tailwind uses box-sizing:border-box).
    return { width: imgW + MAT_PAD, height: imgH + MAT_PAD };
  }, [isFill, naturalDims, thumbHeight, contentWidth]);

  const previewUrl = useMemo(() => {
    if (mimeType?.startsWith("image/") && downloadUrl) return downloadUrl;
    return thumbnailUrl;
  }, [downloadUrl, mimeType, thumbnailUrl]);

  const handleImageLoad = useCallback((event: SyntheticEvent<HTMLImageElement>) => {
    const img = event.currentTarget;
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (w && h) {
      const dims = { w, h };
      setNaturalDims(dims);
      onNaturalDims?.(dims);
    }
  }, [onNaturalDims]);

  // Single return — keeps the Card DOM node stable across the natural→fill transition
  // so React patches props in-place rather than unmounting/remounting (which flickered the border).
  return (
    <Card style={isFill ? { height: thumbHeight } : undefined}>
      <CardContent ref={cardContentRef} className={isFill ? "p-4 h-full flex items-center justify-center" : "p-4"}>
        {thumbState === "PENDING" ? (
          isFill
            ? <Skeleton className="w-full h-full rounded-md" />
            : <Skeleton className="w-full rounded-md" style={{ height: "200px" }} />
        ) : thumbError ? (
          <div className={`flex w-full items-center justify-center ${isFill ? "h-full" : "h-64"}`}>
            {createElement(mediaTypeIcon, { className: "h-20 w-20 text-muted-foreground" })}
          </div>
        ) : previewUrl ? (
          <div
            className="preview-mat rounded-md p-2"
            style={isFill
              ? (matStyle ?? { width: "100%", height: "100%" })
              : { width: "100%" }
            }
          >
            <img
              src={previewUrl}
              alt={title}
              onLoad={handleImageLoad}
              className={`block w-full${isFill ? " h-full" : " h-auto"}`}
            />
          </div>
        ) : (
          <div className={`flex items-center justify-center text-sm text-muted-foreground ${isFill ? "h-full w-full" : "h-48 w-72"}`}>
            No preview available
          </div>
        )}
      </CardContent>
    </Card>
  );
}
