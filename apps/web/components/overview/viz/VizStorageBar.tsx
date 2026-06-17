"use client";

import { useState, useEffect } from "react";
import type { CSSProperties } from "react";
import { formatBytes } from "@/lib/media/utils";

interface Props {
  storageBytes: number;
}

// No hard quota exists for a self-hosted vault, so the fill height is a
// magnitude indicator on a log scale spanning 1 MB → 1 TB. This keeps the
// bar visually meaningful across very different vault sizes.
const MIN_BYTES = 1024 * 1024;               // 1 MB  → ~0%
const MAX_BYTES = 1024 * 1024 * 1024 * 1024; // 1 TB  → 100%
const LOG_MIN   = Math.log10(MIN_BYTES);
const LOG_SPAN  = Math.log10(MAX_BYTES) - LOG_MIN;

function fillPercent(bytes: number): number {
  if (bytes <= 0) return 0;
  const pct = ((Math.log10(bytes) - LOG_MIN) / LOG_SPAN) * 100;
  return Math.max(4, Math.min(100, pct));
}

export function VizStorageBar({ storageBytes }: Props) {
  const [animated, setAnimated] = useState(false);

  useEffect(() => {
    const id = setTimeout(() => setAnimated(true), 50);
    return () => clearTimeout(id);
  }, []);

  const pct = fillPercent(storageBytes);

  return (
    <div className="viz-storage-meter" title={`${formatBytes(storageBytes)} stored`}>
      <div className="viz-storage-meter-track">
        <div
          className="viz-storage-meter-fill"
          style={{ "--meter-fill": animated ? `${pct}%` : "0%" } as CSSProperties}
        />
      </div>
      <div className="viz-storage-meter-value">{formatBytes(storageBytes)}</div>
    </div>
  );
}
