"use client";

import Link from "next/link";
import { HardDrive } from "lucide-react";
// NOTE: VizDonut (the pie chart) is intentionally stashed — it was removed from
// this panel on 2026-06-17 but kept for future reuse. See viz/VizDonut.tsx.
import { VizTreemap } from "./viz/VizTreemap";
import { VizStorageBar } from "./viz/VizStorageBar";
import { mergedLegend } from "./viz/vizUtils";
import type { MediaStorageItem } from "@vault/types";

interface Props {
  docs: MediaStorageItem[];
  mediaStats: {
    totalDocs: number;
    storageBytes: number;
    typeBreakdown: Array<{ mimeType: string; count: number }>;
  };
}

export function OverviewVizPanel({ docs, mediaStats }: Props) {
  const legend = mergedLegend(mediaStats.typeBreakdown, docs);

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
            <div className="viz-section-label">Storage</div>
            <div className="viz-combined-body">
              {/* Compact (ratio) mode: only the dominant files, so the home card
                  shows a proportional sample rather than every file in the vault.
                  Labels off to keep it clean — the full set lives on /explore. */}
              <VizTreemap docs={docs} compact showLabels={false} />
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
