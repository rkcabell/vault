"use client";

import { useState, useEffect } from "react";
import { useUpload } from "@/components/contexts/UploadContext";
import { useDerivativeProgress } from "@/components/contexts/DerivativeProgressContext";
import { clearFailedJobs } from "@/lib/media/jobs";
import type { WorkerCounts } from "@/lib/api.server";

interface Props {
  initial: WorkerCounts | null;
}

const WORKERS = [
  { label: "Text Worker",      worker: "text"  as const },
  { label: "OCR Worker",       worker: "ocr"   as const },
  { label: "Thumbnail Worker", worker: "thumb" as const },
] as const;

/** Waiting comes from the database, not the queue — the feeder keeps Redis at
 *  the working set, so `ocr_queue` in particular sits near zero while tens of
 *  thousands of NEEDS_OCR rows wait. Active and delayed are genuine queue facts. */
const QUEUE_FIELDS = ["active", "delayed", "failed"] as const;

export function OverviewWorkerPoller({ initial }: Props) {
  const [counts, setCounts] = useState<WorkerCounts | null>(initial);
  const { files } = useUpload();
  const { progress } = useDerivativeProgress();

  const isUploading = files.some(f => f.status === "pending" || f.status === "uploading");

  const [clearing, setClearing] = useState<string | null>(null);

  const handleClearFailed = async (worker: string) => {
    if (clearing) return;
    if (!window.confirm("Clear the failed job records for this worker? Media items in a failed state are not affected.")) return;
    setClearing(worker);
    try {
      await clearFailedJobs(worker);
      const res = await fetch("/api/server/workers", { cache: "no-store" });
      if (res.ok) setCounts((await res.json()) as WorkerCounts);
    } finally {
      setClearing(null);
    }
  };

  const needsOcr = progress?.needsOcr ?? 0;
  const waitingFor = (worker: "text" | "ocr" | "thumb"): number | null => {
    if (!progress) return null;
    if (worker === "ocr") return needsOcr;
    if (worker === "thumb") return progress.thumb.pending;
    // text.pending spans both tiers; the difference is the native-extraction half.
    return Math.max(0, progress.text.pending - needsOcr);
  };

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
          const busy = WORKERS.some(({ worker }) => {
            const q = data[worker]?.counts;
            return (q?.active ?? 0) > 0 || (q?.waiting ?? 0) > 0;
          });
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
            <div className="overview-worker-row">
              <span>Waiting</span>
              <span className="overview-worker-count">
                {waitingFor(worker)?.toLocaleString() ?? "—"}
              </span>
            </div>
            {QUEUE_FIELDS.map(key => {
              const val = w?.counts[key];
              const isFailed = key === "failed" && val != null && val > 0;
              return (
                <div key={key} className={`overview-worker-row${isFailed ? " overview-worker-row--failed" : ""}`}>
                  <span className="capitalize">{key}</span>
                  <span className="flex items-center gap-2">
                    {isFailed && (
                      <button
                        type="button"
                        onClick={() => void handleClearFailed(worker)}
                        disabled={clearing === worker}
                        className="text-xs underline underline-offset-2 hover:text-foreground disabled:opacity-50"
                      >
                        {clearing === worker ? "Clearing…" : "Clear"}
                      </button>
                    )}
                    <span className={`overview-worker-count${isFailed ? " overview-worker-count--failed" : ""}`}>
                      {val ?? "—"}
                    </span>
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
