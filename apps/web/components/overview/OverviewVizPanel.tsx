"use client";

import Link from "next/link";
import { HardDrive } from "lucide-react";
// NOTE: VizDonut (the pie chart) is intentionally stashed — it was removed from
// this panel on 2026-06-17 but kept for future reuse. See viz/VizDonut.tsx.
import { VizCategoryTreemap } from "./viz/VizCategoryTreemap";
import { VizStorageBar } from "./viz/VizStorageBar";
import { bucketColor, BUCKET_LABEL, BUCKET_ORDER, type BucketKey } from "./viz/vizUtils";
import type { MediaCategorySlice } from "@vault/types";

interface Props {
  categories: MediaCategorySlice[];
  mediaStats: {
    totalDocs: number;
    storageBytes: number;
    typeBreakdown: Array<{ mimeType: string; count: number }>;
  };
}

export function OverviewVizPanel({ categories, mediaStats }: Props) {
  // Legend mirrors the category tiles: one entry per present bucket, in the
  // canonical bucket order, coloured to match its tile.
  const present = new Set(categories.filter(c => c.bytes > 0).map(c => c.bucket as BucketKey));
  const legend = BUCKET_ORDER
    .filter(b => present.has(b))
    .map(b => ({ label: BUCKET_LABEL[b], color: bucketColor(b) }));

  return (
    <section className="flex flex-col gap-3 min-w-0">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Explore</h2>
        <Link href="/explore" className="text-xs text-muted-foreground hover:underline">
          Full view →
        </Link>
      </div>

      <div className="overview-card rounded-2xl border overflow-hidden flex flex-col flex-1 min-h-0">
        <div className="viz-combined">
          <div className="viz-storage-spine">
            <div className="viz-section-label viz-storage-spine-label">
              <HardDrive className="h-3.5 w-3.5" />
            </div>
            <div className="viz-combined-body">
              <VizStorageBar storageBytes={mediaStats.storageBytes} />
            </div>
          </div>

          {/* Pie chart (VizDonut) stashed for later — intentionally not rendered. See viz/VizDonut.tsx */}

          <div className="viz-combined-storage">
            <div className="viz-section-label">Storage by type</div>
            <div className="viz-combined-body">
              {/* One tile per file-type category, sized by the storage it
                  occupies and labelled with file count + total size. The
                  per-file detail view lives on /explore. */}
              <VizCategoryTreemap categories={categories} />
            </div>
          </div>
        </div>

        {legend.length > 0 && (
          <div className="viz-legend">
            {legend.map(item => (
              <div key={item.label} className="viz-legend-item">
                <span
                  className="viz-legend-dot"
                  style={{ backgroundColor: item.color }}
                />
                <span>{item.label}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
