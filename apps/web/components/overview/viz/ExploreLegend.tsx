"use client";

import type { MediaStorageItem } from "@vault/types";
import { bucketOf, bucketColor, BUCKET_LABEL, BUCKET_ORDER, type BucketKey } from "./vizUtils";

/**
 * Legend + category filter for the /explore treemap. Each bucket present in the
 * data is a toggle button; toggling it highlights every tile of that colour
 * (handled by the treemap). Reflects the buckets present in the data set.
 */

interface Props {
  docs: MediaStorageItem[];
  active: ReadonlySet<BucketKey>;
  onToggle: (bucket: BucketKey) => void;
}

export function ExploreLegend({ docs, active, onToggle }: Props) {
  const present = new Set<BucketKey>();
  for (const d of docs) present.add(bucketOf(d.mimeType, d.filename));

  const items = BUCKET_ORDER.filter(b => present.has(b));
  if (items.length === 0) return null;

  return (
    <div className="explore-legend" role="group" aria-label="Filter by type">
      {items.map(b => {
        const on = active.has(b);
        return (
          <button
            key={b}
            type="button"
            className={"explore-legend-item" + (on ? " explore-legend-item--active" : "")}
            aria-pressed={on}
            onClick={() => onToggle(b)}
          >
            <span className="explore-legend-dot" style={{ backgroundColor: bucketColor(b) }} />
            <span>{BUCKET_LABEL[b]}</span>
          </button>
        );
      })}
    </div>
  );
}
