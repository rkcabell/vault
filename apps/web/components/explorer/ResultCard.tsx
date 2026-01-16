//File: apps/web/components/explorer/ResultCard.tsx
"use client";

import { useCallback, type SyntheticEvent } from "react";
import Link from "next/link";
import { StatusChip } from "@/components/common";
import { deriveOverallState } from "@/lib/media/status";
import type { MediaWorkerState } from "@/lib/media/types";

export type MediaItem = {
  id: string;
  title?: string | null;
  filename?: string | null;
  thumbState?: MediaWorkerState | null;
  textState?: MediaWorkerState | null;
  tags?: string[];
  mimeType?: string | null;
};

export default function ResultCard({ item }: { item: MediaItem }) {
  const id = item.id;
  const overallState = deriveOverallState(item.thumbState, item.textState);
  const fallbackKind =
    item.mimeType?.startsWith("image/") ? "image" : item.mimeType === "application/pdf" ? "pdf" : "file";
  const fallbackUrl = `/thumbnails/fallback?kind=${fallbackKind}`;
  const thumbVersion = item.thumbState === "READY" ? "ready" : "pending";
  const thumbnailSrc = `/api/media/${item.id}/thumbnail?v=${thumbVersion}`;

  const handleThumbError = useCallback(
    (event: SyntheticEvent<HTMLImageElement>) => {
      const img = event.currentTarget;
      if (img.dataset.fallbackApplied === "true") return;
      img.dataset.fallbackApplied = "true";
      img.src = fallbackUrl;
    },
    [fallbackUrl],
  );

  return (
    <Link href={{ pathname: "/media/[id]", query: { id } }} className="block rounded border bg-white p-2 hover:shadow">
      <div className="aspect-[4/3] overflow-hidden rounded bg-neutral-100">
        <img
          key={`${item.id}-${thumbVersion}`}
          src={thumbnailSrc}
          alt={item.title ?? "thumb"}
          className="h-full w-full object-cover"
          onError={handleThumbError}
          loading="lazy"
        />
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <div className="truncate text-sm">{item.title ?? item.filename ?? "Untitled"}</div>
        <StatusChip status={overallState} />
      </div>
      {item.tags?.length ? (
        <div className="mt-1 line-clamp-1 text-xs opacity-70">#{item.tags.join(" #")}</div>
      ) : null}
    </Link>
  );
}
