"use client";

import { useState } from "react";
import type { MediaStorageItem } from "@vault/types";
import { VizTreemap } from "./VizTreemap";
import { ExploreLegend } from "./ExploreLegend";
import { ExploreStatbar } from "./ExploreStatbar";
import type { BucketKey } from "./vizUtils";

// Keep in sync with VizTreemap's DEFAULT_SIZE_AREA_EXP / DEFAULT_MIN_AREA_FRAC.
const DEFAULT_EXP  = 0.5;
const DEFAULT_FRAC = 0.06;

interface Props {
  docs: MediaStorageItem[];
}

export function ExploreTreemapView({ docs }: Props) {
  const [sizeAreaExp, setSizeAreaExp] = useState(DEFAULT_EXP);
  const [minAreaFrac, setMinAreaFrac] = useState(DEFAULT_FRAC);
  const [highlight, setHighlight]     = useState<ReadonlySet<BucketKey>>(new Set());
  const [selected, setSelected]       = useState<MediaStorageItem | null>(null);

  const toggleBucket = (b: BucketKey) => {
    setHighlight(prev => {
      const next = new Set(prev);
      if (next.has(b)) next.delete(b); else next.add(b);
      return next;
    });
  };

  const isDefault = sizeAreaExp === DEFAULT_EXP && minAreaFrac === DEFAULT_FRAC;

  return (
    <>
      <div className="explore-controls">
        <label className="explore-control">
          <span className="explore-control-label">
            Size emphasis <span className="explore-control-value">{sizeAreaExp.toFixed(2)}</span>
          </span>
          <input
            type="range"
            min={0.1}
            max={1}
            step={0.05}
            value={sizeAreaExp}
            onChange={e => setSizeAreaExp(Number(e.target.value))}
          />
          <span className="explore-control-hint">flat ↔ true file size</span>
        </label>

        <label className="explore-control">
          <span className="explore-control-label">
            Min tile size <span className="explore-control-value">{Math.round(minAreaFrac * 100)}%</span>
          </span>
          <input
            type="range"
            min={0}
            max={0.25}
            step={0.01}
            value={minAreaFrac}
            onChange={e => setMinAreaFrac(Number(e.target.value))}
          />
          <span className="explore-control-hint">smallest-tile floor</span>
        </label>

        <button
          type="button"
          className="explore-control-reset"
          onClick={() => { setSizeAreaExp(DEFAULT_EXP); setMinAreaFrac(DEFAULT_FRAC); }}
          disabled={isDefault}
        >
          Reset
        </button>
      </div>

      <div className="overview-card rounded-2xl border overflow-hidden flex flex-col">
        <div className="explore-treemap">
          <VizTreemap
            docs={docs}
            sizeAreaExp={sizeAreaExp}
            minAreaFrac={minAreaFrac}
            highlightBuckets={highlight}
            selectedId={selected?.id ?? null}
            onSelect={setSelected}
          />
        </div>
        <ExploreLegend docs={docs} active={highlight} onToggle={toggleBucket} />
      </div>

      <ExploreStatbar selected={selected} />
    </>
  );
}
