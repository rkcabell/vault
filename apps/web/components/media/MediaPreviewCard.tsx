'use client'

import { useCallback, createElement, useMemo, useState, type SyntheticEvent } from "react";
import { Archive, BookOpen, File as FileIcon, FileText, Film, Music, type LucideIcon } from "lucide-react";
import { Card, CardContent } from "@/components/ui/Card";
import { Skeleton } from "@/components/ui/Skeleton";

type DisplaySize = { width: number; height: number };

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

export function MediaPreviewCard (props: {
  thumbnailUrl: string | null;
  downloadUrl?: string | null;
  mimeType?: string | null;
  title: string;
  thumbState?: string | null;
}) {
  const { thumbnailUrl, downloadUrl, mimeType, title, thumbState } = props;
  const [displaySize, setDisplaySize] = useState<DisplaySize | null>(null);
  const thumbError = thumbState === "ERROR" || thumbState === "FAILED";
  const mediaTypeIcon = getMediaTypeIcon(mimeType);

  const previewUrl = useMemo(() => {
    if (mimeType?.startsWith("image/") && downloadUrl) return downloadUrl;
    return thumbnailUrl;
  }, [downloadUrl, mimeType, thumbnailUrl]);

  const handleImageLoad = useCallback(
    (event: SyntheticEvent<HTMLImageElement>) => {
      const img = event.currentTarget;
      const naturalWidth = img.naturalWidth || img.width;
      const naturalHeight = img.naturalHeight || img.height;
      if (!naturalWidth || !naturalHeight) return;

      const maxWidth = window.innerWidth * 0.9;
      const maxHeight = window.innerHeight * 0.7;
      const tooLarge = naturalWidth > maxWidth || naturalHeight > maxHeight;
      const scale = tooLarge ? 0.5 : 1;

      setDisplaySize({
        width: Math.round(naturalWidth * scale),
        height: Math.round(naturalHeight * scale),
      });
    },
    [],
  );

  return (
    <Card>
      <CardContent className="p-4">
        {thumbState === "PENDING" ? (
          <Skeleton className="w-full rounded-md" style={{ height: "512px" }} />
        ) : thumbError ? (
          <div className="flex h-64 w-full items-center justify-center">
            {createElement(mediaTypeIcon, { className: "h-20 w-20 text-muted-foreground" })}
          </div>
        ) : (
        <div className="flex justify-center">
          <div className="preview-mat max-w-full overflow-auto rounded-md p-2">
            {previewUrl ? (
              <img
                src={previewUrl}
                alt={title}
                onLoad={handleImageLoad}
                style={
                  displaySize
                    ? { width: displaySize.width, height: displaySize.height }
                    : undefined
                }
                className="object-contain"
              />
            ) : (
              <div className="flex h-48 w-72 items-center justify-center text-sm text-muted-foreground">
                No preview available
              </div>
            )}
          </div>
        </div>
        )}
      </CardContent>
    </Card>
  );
}
