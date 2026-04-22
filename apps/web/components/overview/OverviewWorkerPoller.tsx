"use client";

import { useState, useEffect } from "react";
import { useUpload } from "@/components/contexts/UploadContext";
import type { WorkerCounts } from "@/lib/api.server";

interface Props {
  initial: WorkerCounts | null;
}

export function OverviewWorkerPoller({ initial }: Props) {
  const [counts, setCounts] = useState<WorkerCounts | null>(initial);
  const { files } = useUpload();

  const isUploading = files.some(f => f.status === "pending" || f.status === "uploading");

  useEffect(() => {
    let timeoutId: ReturnType<typeof setTimeout>;
    let cancelled = false;

    const tick = async () => {
      if (cancelled) return;
      try {
        const res = await fetch("/api/server/workers", { cache: "no-store" });
        if (cancelled) return;
        if (res.ok) {
          const data: WorkerCounts = await res.json();
          if (cancelled) return;
          setCounts(data);
          const busy =
            data.ocr.counts.active   > 0 || data.ocr.counts.waiting   > 0 ||
            data.thumb.counts.active > 0 || data.thumb.counts.waiting > 0;
          timeoutId = setTimeout(tick, (busy || isUploading) ? 3_000 : 60_000);
          return;
        }
      } catch {
        // keep stale data
      }
      if (!cancelled) timeoutId = setTimeout(tick, 30_000);
    };

    void tick();
    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, [isUploading]);

  const ocrTotal  = counts ? counts.ocr.counts.waiting  + counts.ocr.counts.active  : null;
  const thumbTotal = counts ? counts.thumb.counts.waiting + counts.thumb.counts.active : null;

  return (
    <>
      <div className="overview-stat-card">
        <div className="overview-stat-label">OCR Queue</div>
        <div className="overview-stat-value">{ocrTotal === null ? "—" : ocrTotal}</div>
        {counts && (
          <div className="overview-stat-sub">
            {counts.ocr.counts.active} active · {counts.ocr.counts.waiting} waiting
            {counts.ocr.counts.failed > 0 && ` · ${counts.ocr.counts.failed} failed`}
          </div>
        )}
      </div>

      <div className="overview-stat-card">
        <div className="overview-stat-label">Thumbnail Queue</div>
        <div className="overview-stat-value">{thumbTotal === null ? "—" : thumbTotal}</div>
        {counts && (
          <div className="overview-stat-sub">
            {counts.thumb.counts.active} active · {counts.thumb.counts.waiting} waiting
            {counts.thumb.counts.failed > 0 && ` · ${counts.thumb.counts.failed} failed`}
          </div>
        )}
      </div>
    </>
  );
}
