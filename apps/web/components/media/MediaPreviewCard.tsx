'use client'

import { useCallback, useMemo, useState, type SyntheticEvent } from "react";
import { Card, CardContent } from "@/components/ui/Card";
import { Skeleton } from "@/components/ui/Skeleton";

type DisplaySize = { width: number; height: number };

export function MediaPreviewCard (props: {
  thumbnailUrl: string | null;
  downloadUrl?: string | null;
  mimeType?: string | null;
  title: string;
  thumbState?: string | null;
}) {
  const { thumbnailUrl, downloadUrl, mimeType, title, thumbState } = props;
  const [displaySize, setDisplaySize] = useState<DisplaySize | null>(null);

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
