"use client";

import { useRef, useEffect, useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { formatBytes } from "@/lib/media/utils";
import { typeColor, bucketOf, type BucketKey } from "./vizUtils";
import { squarifyLayout, tileWeights, type Bounds } from "./treemapLayout";
import type { MediaStorageItem } from "@vault/types";

interface TmNode extends Bounds {
  id: string;
  title: string | null;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  /** Area-driving weight (== sizeBytes for exact tiles, inflated for samples). */
  weight: number;
  /** Representative tail-sample tile (drawn distinctly). */
  sampled: boolean;
  /** How many real files a sampled tile stands in for. */
  representsCount: number;
}

interface TooltipState {
  x: number;
  y: number;
  node: TmNode;
}

type LayoutItem = Pick<TmNode, "id" | "title" | "filename" | "mimeType" | "sizeBytes" | "weight" | "sampled" | "representsCount">;

// --- Tile weighting --------------------------------------------------------
// A squarified treemap subdivides the container with ZERO gaps. To stop a few
// huge files from dominating (and reducing the rest to slivers), each tile's
// AREA is a dampened function of size: area ∝ √size, with a floor so the
// smallest tiles stay visible. This deliberately trades exact size precision
// for a clean, gap-free fill.
// Defaults (overridable per-instance via props / on-page controls).
const DEFAULT_SIZE_AREA_EXP = 0.5;   // tile area ∝ size^0.5  (√size)
const DEFAULT_MIN_AREA_FRAC = 0.06;  // smallest tile area ≥ 6% of the largest

/** Area-driving weight: sampled tail tiles inflate weightBytes above sizeBytes. */
function weightOf(d: MediaStorageItem): number {
  return d.weightBytes ?? d.sizeBytes ?? 0;
}

/** Lay tiles out as a gapless, dampened squarified treemap. */
function treemapLayout(items: LayoutItem[], container: Bounds, sizeAreaExp: number, minAreaFrac: number): TmNode[] {
  if (items.length === 0 || container.w <= 0 || container.h <= 0) return [];
  const weights = tileWeights(items.map(it => it.weight), sizeAreaExp, minAreaFrac);
  return squarifyLayout(items, weights, { x: 0, y: 0, w: container.w, h: container.h });
}

// Compact (homepage) mode keeps only the dominant files so the treemap reads
// as a clean ratio of the largest items rather than a dense field of slivers.
const RATIO_MIN_SHARE = 0.015; // drop files below 1.5% of total bytes
const RATIO_MAX_CELLS = 20;    // hard cap on cells
const RATIO_MIN_CELLS = 6;     // always show at least this many largest files

/** Trim a size-sorted list down to the dominant files for the ratio view. */
function pickRatioDocs(sorted: MediaStorageItem[]): MediaStorageItem[] {
  if (sorted.length <= RATIO_MIN_CELLS) return sorted;
  const total = sorted.reduce((s, d) => s + (d.sizeBytes ?? 0), 0);
  if (total <= 0) return sorted.slice(0, RATIO_MAX_CELLS);
  const kept = sorted.filter(d => (d.sizeBytes ?? 0) / total >= RATIO_MIN_SHARE);
  const floored = kept.length >= RATIO_MIN_CELLS ? kept : sorted.slice(0, RATIO_MIN_CELLS);
  return floored.slice(0, RATIO_MAX_CELLS);
}

interface Props {
  docs: MediaStorageItem[];
  /** Hide per-cell text labels (tooltip is unaffected). Default: shown. */
  showLabels?: boolean;
  /** Ratio mode — drop the smallest files so only dominant cells render. */
  compact?: boolean;
  /** Size→area dampening exponent (area ∝ size^exp). 1 = true size, lower = flatter. */
  sizeAreaExp?: number;
  /** Smallest tile area as a fraction of the largest. */
  minAreaFrac?: number;
  /** If provided, clicking a tile selects it (calls this) instead of navigating. */
  onSelect?: (file: MediaStorageItem) => void;
  /** Id of the currently selected tile (drawn with a white inset ring). */
  selectedId?: string | null;
  /** Buckets to highlight (white inner border) — drives legend filtering. */
  highlightBuckets?: ReadonlySet<BucketKey>;
}

export function VizTreemap({
  docs,
  showLabels = true,
  compact = false,
  sizeAreaExp = DEFAULT_SIZE_AREA_EXP,
  minAreaFrac = DEFAULT_MIN_AREA_FRAC,
  onSelect,
  selectedId = null,
  highlightBuckets,
}: Props) {
  const router       = useRouter();
  const containerRef = useRef<HTMLDivElement>(null);
  const [nodes, setNodes]     = useState<TmNode[]>([]);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);

  // Sort by the area-driving weight (server-sampled tiles inflate weightBytes
  // above their real sizeBytes). Memoized — without it this re-sorts the whole
  // list on every render, including each tooltip mouse-move.
  const validDocs = useMemo(() => {
    const sorted = docs.filter(d => weightOf(d) > 0).sort((a, b) => weightOf(b) - weightOf(a));
    return compact ? pickRatioDocs(sorted) : sorted;
  }, [docs, compact]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    function compute() {
      const { width, height } = el!.getBoundingClientRect();
      if (width === 0 || height === 0) return;
      const computed = treemapLayout(
        validDocs.map(d => ({
          id: d.id,
          title: d.title,
          filename: d.filename,
          mimeType: d.mimeType,
          sizeBytes: d.sizeBytes!,
          weight: d.weightBytes ?? d.sizeBytes!,
          sampled: d.sampled ?? false,
          representsCount: d.representsCount ?? 1,
        })),
        { x: 0, y: 0, w: width, h: height },
        sizeAreaExp,
        minAreaFrac,
      );
      setNodes(computed);
    }

    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docs, compact, sizeAreaExp, minAreaFrac]);

  if (validDocs.length === 0) {
    return (
      <div className="viz-treemap-wrap">
        <div className="viz-treemap" ref={containerRef}>
          <div className="viz-treemap-empty">No size data yet.</div>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="viz-treemap-wrap">
        <div className="viz-treemap" ref={containerRef}>
          {nodes.map(node => {
            const filtering   = (highlightBuckets?.size ?? 0) > 0;
            const highlighted = highlightBuckets?.has(bucketOf(node.mimeType, node.filename)) ?? false;
            const selected    = node.id === selectedId;
            // Only dim when a category filter is active — never on plain selection.
            const dimmed      = filtering && !highlighted;
            return (
              <div
                key={node.id}
                className={
                  "viz-treemap-cell" +
                  (highlighted   ? " viz-treemap-cell--highlight" : "") +
                  (selected      ? " viz-treemap-cell--selected"  : "") +
                  (dimmed        ? " viz-treemap-cell--dimmed"    : "") +
                  (node.sampled  ? " viz-treemap-cell--sampled"   : "")
                }
                style={{
                  left:            node.x,
                  top:             node.y,
                  width:           node.w,
                  height:          node.h,
                  backgroundColor: typeColor(node.mimeType, node.filename),
                }}
                onClick={() => onSelect
                  ? onSelect({ id: node.id, title: node.title, filename: node.filename, mimeType: node.mimeType, sizeBytes: node.sizeBytes })
                  : router.push(`/media/${node.id}`)}
                onMouseMove={e => setTooltip({ x: e.clientX + 12, y: e.clientY + 12, node })}
                onMouseLeave={() => setTooltip(null)}
              >
                {showLabels && node.w > 30 && node.h > 18 && (
                  <div className="viz-treemap-cell-label">
                    {node.title || node.filename}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {tooltip && (
        <div
          className="viz-treemap-tooltip"
          style={{ left: tooltip.x, top: tooltip.y }}
        >
          <div className="font-medium">{tooltip.node.title || tooltip.node.filename}</div>
          <div className="text-muted-foreground">{formatBytes(tooltip.node.sizeBytes)}</div>
          {tooltip.node.sampled && (
            <div className="text-muted-foreground">
              representative of ≈{tooltip.node.representsCount.toLocaleString()} similar files
            </div>
          )}
        </div>
      )}
    </>
  );
}
