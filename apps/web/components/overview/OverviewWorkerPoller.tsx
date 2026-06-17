"use client";

import { useState, useEffect } from "react";
import { useUpload } from "@/components/contexts/UploadContext";
import type { WorkerCounts } from "@/lib/api.server";

interface Props {
  initial: WorkerCounts | null;
}

const WORKERS = [
  { label: "OCR Worker",       worker: "ocr"   as const },
  { label: "Thumbnail Worker", worker: "thumb" as const },
] as const;

const QUEUE_FIELDS = ["waiting", "active", "delayed", "failed"] as const;

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

  return (
    <div className="flex flex-col gap-3">
      {WORKERS.map(({ label, worker }) => {
        const w = counts?.[worker];
        return (
          <div key={label} className="overview-worker-card">
            <div className="flex items-center justify-between mb-2">
              <span className="overview-worker-label">{label}</span>
              {w && (
                <span className={`text-xs font-medium ${w.active ? "overview-worker-status--active" : "overview-worker-status--idle"}`}>
                  {w.active ? "Running" : "Idle"}
                </span>
              )}
            </div>
            {QUEUE_FIELDS.map(key => {
              const val = w?.counts[key];
              const isFailed = key === "failed" && val != null && val > 0;
              return (
                <div key={key} className={`overview-worker-row${isFailed ? " overview-worker-row--failed" : ""}`}>
                  <span className="capitalize">{key}</span>
                  <span className={`overview-worker-count${isFailed ? " overview-worker-count--failed" : ""}`}>
                    {val ?? "—"}
                  </span>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
