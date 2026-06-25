"use client";

import { useRef, useEffect, useState } from "react";
import { formatBytes } from "@/lib/media/utils";
import { bucketColor, BUCKET_LABEL, type BucketKey } from "./vizUtils";
import { squarifyLayout, tileWeights, type Bounds } from "./treemapLayout";
import type { MediaCategorySlice } from "@vault/types";

// Storage-by-file-type graph: one gapless tile per file-type category, sized by
// the category's true byte footprint. Unlike the per-file treemap this is a
// small, fixed set of tiles (≤10), so area tracks bytes directly (exp=1) — only
// a light floor keeps a tiny category visible/hoverable.
const CAT_SIZE_AREA_EXP = 1;     // tile area ∝ bytes (true proportions)
const CAT_MIN_AREA_FRAC = 0.03;  // smallest tile area ≥ 3% of the largest

interface CatNode extends Bounds, MediaCategorySlice {}

interface TooltipState { x: number; y: number; node: CatNode }

interface Props {
  categories: MediaCategorySlice[];
}

export function VizCategoryTreemap({ categories }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [nodes, setNodes]     = useState<CatNode[]>([]);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    function compute() {
      const { width, height } = el!.getBoundingClientRect();
      if (width === 0 || height === 0) return;
      const sorted = categories.filter(c => c.bytes > 0).sort((a, b) => b.bytes - a.bytes);
      const weights = tileWeights(sorted.map(c => c.bytes), CAT_SIZE_AREA_EXP, CAT_MIN_AREA_FRAC);
      setNodes(squarifyLayout(sorted, weights, { x: 0, y: 0, w: width, h: height }));
    }

    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [categories]);

  const hasData = categories.some(c => c.bytes > 0);

  if (!hasData) {
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
          {nodes.map(node => (
            <div
              key={node.bucket}
              className="viz-treemap-cell viz-treemap-cell--category"
              style={{
                left:            node.x,
                top:             node.y,
                width:           node.w,
                height:          node.h,
                backgroundColor: bucketColor(node.bucket as BucketKey),
              }}
              onMouseMove={e => setTooltip({ x: e.clientX + 12, y: e.clientY + 12, node })}
              onMouseLeave={() => setTooltip(null)}
            >
              {node.w > 54 && node.h > 26 && (
                <div className="viz-cat-label">
                  <span className="viz-cat-name">{BUCKET_LABEL[node.bucket as BucketKey]}</span>
                  <span className="viz-cat-size">{formatBytes(node.bytes)}</span>
                  {node.h > 64 && (
                    <span className="viz-cat-count">
                      {node.count.toLocaleString()} {node.count === 1 ? "file" : "files"}
                    </span>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {tooltip && (
        <div className="viz-treemap-tooltip" style={{ left: tooltip.x, top: tooltip.y }}>
          <div className="font-medium">{BUCKET_LABEL[tooltip.node.bucket as BucketKey]}</div>
          <div className="text-muted-foreground">
            {tooltip.node.count.toLocaleString()} {tooltip.node.count === 1 ? "file" : "files"} · {formatBytes(tooltip.node.bytes)}
          </div>
        </div>
      )}
    </>
  );
}
