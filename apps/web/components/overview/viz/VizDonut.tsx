"use client";

/* ──────────────────────────────────────────────────────────────────────────
 * STASHED — NOT CURRENTLY RENDERED. Do not delete.
 * This donut/pie chart of document type counts was removed from the homepage
 * Explore panel on 2026-06-17. It is kept intentionally for future reuse
 * (e.g. on the /explore page or a revived homepage card). If you re-introduce
 * it, wire it back into a panel and remove this banner.
 * ────────────────────────────────────────────────────────────────────────── */

import { useState, useEffect } from "react";
import { formatBytes } from "@/lib/media/utils";
import { bucketByLabel } from "./vizUtils";

interface Props {
  mediaStats: {
    totalDocs: number;
    storageBytes: number;
    typeBreakdown: Array<{ mimeType: string; count: number }>;
  };
}

const RADIUS = 70;
const STROKE  = 28;
const CIRC    = 2 * Math.PI * RADIUS; // ≈ 439.82

export function VizDonut({ mediaStats }: Props) {
  const { totalDocs, storageBytes, typeBreakdown } = mediaStats;
  const [animated, setAnimated]       = useState(false);
  const [centerMode, setCenterMode]   = useState<"count" | "storage">("count");

  useEffect(() => {
    const id = setTimeout(() => setAnimated(true), 50);
    return () => clearTimeout(id);
  }, []);

  const buckets = bucketByLabel(typeBreakdown);
  const total   = buckets.reduce((s, b) => s + b.count, 0);

  if (buckets.length === 0) {
    return (
      <div className="viz-donut-wrap">
        <p className="text-sm text-muted-foreground">No documents yet.</p>
      </div>
    );
  }

  // Build segments: each gets a dasharray + dashoffset to position it around the ring
  // We rotate the whole SVG -90° so the first segment starts at 12 o'clock.
  // Compute cumulative fraction prefix sums without mutation inside map.
  const fracs = buckets.map(b => b.count / total);
  const offsets = fracs.reduce<number[]>((acc, _, i) => {
    acc.push(i === 0 ? 0 : acc[i - 1]! + fracs[i - 1]!);
    return acc;
  }, []);
  const segments = buckets.map((b, i) => ({
    ...b,
    frac:   fracs[i]!,
    dash:   animated ? fracs[i]! * CIRC : 0,
    offset: -offsets[i]! * CIRC,
  }));

  const centerValue = centerMode === "count"
    ? totalDocs.toLocaleString()
    : formatBytes(storageBytes);
  const centerLabel = centerMode === "count" ? "files" : "storage";

  return (
    <div className="viz-donut-wrap">
      <svg
        viewBox="0 0 200 200"
        className="viz-donut-svg"
        style={{ transform: "rotate(-90deg)" }}
      >
        {/* Background ring */}
        <circle
          cx="100" cy="100" r={RADIUS}
          fill="none"
          stroke="hsl(var(--border))"
          strokeWidth={STROKE}
        />

        {segments.map(seg => (
          <circle
            key={seg.label}
            cx="100" cy="100" r={RADIUS}
            fill="none"
            stroke={seg.color}
            strokeWidth={STROKE}
            strokeDasharray={`${seg.dash} ${CIRC}`}
            strokeDashoffset={seg.offset}
            style={{ transition: "stroke-dasharray 700ms ease" }}
          />
        ))}

        {/* Transparent click target at center, counter-rotated for the text */}
        <g style={{ transform: "rotate(90deg)", transformOrigin: "100px 100px" }}>
          <circle
            cx="100" cy="100" r={RADIUS - STROKE / 2 - 2}
            fill="transparent"
            onClick={() => setCenterMode(m => m === "count" ? "storage" : "count")}
            style={{ cursor: "pointer" }}
          />
          <text
            x="100" y="95"
            textAnchor="middle"
            dominantBaseline="middle"
            fontSize="20"
            fontWeight="700"
            fill="hsl(var(--foreground))"
          >
            {centerValue}
          </text>
          <text
            x="100" y="116"
            textAnchor="middle"
            dominantBaseline="middle"
            fontSize="10"
            fill="hsl(var(--muted-foreground))"
          >
            {centerLabel}
          </text>
        </g>
      </svg>
    </div>
  );
}
