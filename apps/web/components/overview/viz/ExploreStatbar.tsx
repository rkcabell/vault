"use client";

import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import type { MediaStorageItem } from "@vault/types";
import { formatBytes, formatMimeTag } from "@/lib/media/utils";
import { typeColor } from "./vizUtils";

/**
 * Detail bar under the treemap. Shows the selected file as a single compact
 * row (mirroring the Library list density) with a link to open the item.
 */

interface Props {
  selected: MediaStorageItem | null;
}

export function ExploreStatbar({ selected }: Props) {
  if (!selected) {
    return (
      <div className="explore-statbar explore-statbar--empty">
        Select a tile to see its details.
      </div>
    );
  }

  const name = selected.title || selected.filename;
  const tag  = formatMimeTag(selected.mimeType, selected.filename);

  return (
    <div className="explore-statbar">
      <span
        className="explore-statbar-swatch"
        style={{ backgroundColor: typeColor(selected.mimeType, selected.filename) }}
      />
      <span className="explore-statbar-name" title={name}>{name}</span>
      <span className="explore-statbar-tag">{tag}</span>
      <span className="explore-statbar-size">{formatBytes(selected.sizeBytes)}</span>
      <Link href={`/media/${selected.id}`} className="explore-statbar-link">
        Open <ArrowUpRight className="h-3.5 w-3.5" />
      </Link>
    </div>
  );
}
