"use client";

import { useRef, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { formatBytes } from "@/lib/media/utils";
import { typeColor, bucketOf, type BucketKey } from "./vizUtils";
import type { MediaStorageItem } from "@vault/types";

interface Bounds { x: number; y: number; w: number; h: number }

interface TmNode extends Bounds {
  id: string;
  title: string | null;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

interface TooltipState {
  x: number;
  y: number;
  node: TmNode;
}

type LayoutItem = Pick<TmNode, "id" | "title" | "filename" | "mimeType" | "sizeBytes">;

// --- Tile weighting --------------------------------------------------------
// A squarified treemap subdivides the container with ZERO gaps. To stop a few
// huge files from dominating (and reducing the rest to slivers), each tile's
// AREA is a dampened function of size: area ∝ √size, with a floor so the
// smallest tiles stay visible. This deliberately trades exact size precision
// for a clean, gap-free fill.
// Defaults (overridable per-instance via props / on-page controls).
const DEFAULT_SIZE_AREA_EXP = 0.5;   // tile area ∝ size^0.5  (√size)
const DEFAULT_MIN_AREA_FRAC = 0.06;  // smallest tile area ≥ 6% of the largest

function tileWeights(items: LayoutItem[], sizeAreaExp: number, minAreaFrac: number): number[] {
  const raw   = items.map(it => Math.pow(Math.max(it.sizeBytes, 1), sizeAreaExp));
  const floor = Math.max(...raw) * minAreaFrac;
  return raw.map(w => Math.max(w, floor));
}

// --- Squarified treemap (gapless) ------------------------------------------
// Bruls, Huizing & van Wijk. Each item's area is proportional to its (dampened)
// weight; rows are committed greedily to keep aspect ratios close to square.
// Fills the bounds completely — no gaps.
function worstRatio(row: number[], side: number): number {
  const sum = row.reduce((a, b) => a + b, 0);
  const max = Math.max(...row);
  const min = Math.min(...row);
  if (sum === 0 || side === 0) return Infinity;
  return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min));
}

function layoutRow(row: number[], items: LayoutItem[], startIdx: number, bounds: Bounds, isH: boolean): TmNode[] {
  const total = row.reduce((a, b) => a + b, 0);
  const strip = isH ? total / bounds.h : total / bounds.w;
  let pos = 0;
  return row.map((area, i) => {
    const item = items[startIdx + i]!;
    const frac = area / total;
    const node: TmNode = isH
      ? { ...item, x: bounds.x, y: bounds.y + pos, w: strip, h: frac * bounds.h }
      : { ...item, x: bounds.x + pos, y: bounds.y, w: frac * bounds.w, h: strip };
    pos += isH ? frac * bounds.h : frac * bounds.w;
    return node;
  });
}

function squarify(items: LayoutItem[], weights: number[], bounds: Bounds): TmNode[] {
  if (items.length === 0) return [];
  if (items.length === 1) return [{ ...items[0]!, x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h }];

  const totalArea   = bounds.w * bounds.h;
  const totalWeight = weights.reduce((s, w) => s + w, 0);
  const normalized  = weights.map(w => (w / totalWeight) * totalArea);
  const result: TmNode[] = [];

  function layout(normed: number[], startIdx: number, rect: Bounds) {
    if (normed.length === 0) return;
    if (normed.length === 1) {
      result.push({ ...items[startIdx]!, x: rect.x, y: rect.y, w: rect.w, h: rect.h });
      return;
    }
    const isH  = rect.w >= rect.h;
    const side = isH ? rect.h : rect.w;
    let row: number[] = [];
    let rowStart = 0;

    for (let i = 0; i < normed.length; i++) {
      const candidate = [...row, normed[i]!];
      if (row.length === 0 || worstRatio(candidate, side) <= worstRatio(row, side)) {
        row = candidate;
      } else {
        result.push(...layoutRow(row, items, startIdx + rowStart, rect, isH));
        const rowTotal = row.reduce((a, b) => a + b, 0);
        const strip    = isH ? rowTotal / rect.h : rowTotal / rect.w;
        const newRect: Bounds = isH
          ? { x: rect.x + strip, y: rect.y, w: rect.w - strip, h: rect.h }
          : { x: rect.x, y: rect.y + strip, w: rect.w, h: rect.h - strip };
        rowStart += row.length;
        layout(normed.slice(i), startIdx + i, newRect);
        return;
      }
    }
    if (row.length > 0) result.push(...layoutRow(row, items, startIdx + rowStart, rect, isH));
  }

  layout(normalized, 0, bounds);
  return result;
}

/** Lay tiles out as a gapless, dampened squarified treemap. */
function treemapLayout(items: LayoutItem[], container: Bounds, sizeAreaExp: number, minAreaFrac: number): TmNode[] {
  if (items.length === 0 || container.w <= 0 || container.h <= 0) return [];
  return squarify(items, tileWeights(items, sizeAreaExp, minAreaFrac), { x: 0, y: 0, w: container.w, h: container.h });
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

  const sortedDocs = docs
    .filter(d => (d.sizeBytes ?? 0) > 0)
    .sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0));
  const validDocs = compact ? pickRatioDocs(sortedDocs) : sortedDocs;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    function compute() {
      const { width, height } = el!.getBoundingClientRect();
      if (width === 0 || height === 0) return;
      const computed = treemapLayout(
        validDocs.map(d => ({ id: d.id, title: d.title, filename: d.filename, mimeType: d.mimeType, sizeBytes: d.sizeBytes! })),
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
                  (highlighted ? " viz-treemap-cell--highlight" : "") +
                  (selected    ? " viz-treemap-cell--selected"  : "") +
                  (dimmed      ? " viz-treemap-cell--dimmed"    : "")
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
        </div>
      )}
    </>
  );
}
