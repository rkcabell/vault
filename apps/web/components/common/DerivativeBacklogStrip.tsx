"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { useDerivativeProgress } from "@/components/contexts/DerivativeProgressContext";
import { useIndexProgress } from "@/components/contexts/IndexProgressContext";

/** "3h 40m", "12m", "< 1m" — coarse on purpose, this is an estimate. */
function formatEta (seconds: number): string {
  if (seconds < 60) return "< 1m";
  const totalMinutes = Math.round(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}

interface BacklogRow {
  key: string;
  label: string;
  detail: string;
}

/**
 * Persistent, dismissible readout of what the vault is working on — mounted
 * once in AppShell (above `<main>`) rather than per-page, unlike
 * LibraryUpdateBanner's ephemeral scan/delete rows.
 *
 * Rows are independent: each appears while its own work exists and disappears
 * when that work is done, whatever the others are doing. Nothing renders a
 * zero, a placeholder or a finished stage, and the strip unmounts once no row
 * has anything to say. A new kind of vault activity is one more entry in
 * `rows` and nothing else.
 */
export function DerivativeBacklogStrip () {
  const { progress } = useDerivativeProgress();
  const { status: indexStatus } = useIndexProgress();
  const [dismissed, setDismissed] = useState(false);

  const thumbPending = progress?.thumb.pending ?? 0;
  const textPending = progress?.text.pending ?? 0;
  const needsOcr = progress?.needsOcr ?? 0;
  // text.pending counts both tiers (see DerivativeProgress) — the difference is
  // the cheap native-extraction half, and it is the half that finishes in
  // minutes rather than days, so the two are never one number here.
  const tier1Pending = Math.max(0, textPending - needsOcr);

  const scanning = !!indexStatus && !indexStatus.done && indexStatus.state !== "failed";

  const rows: BacklogRow[] = [];

  if (scanning) {
    rows.push({
      key: "index",
      label: "Indexing",
      detail: `${indexStatus.indexed.toLocaleString()} of ${indexStatus.scanned.toLocaleString()} scanned`,
    });
  }
  if (progress && thumbPending > 0) {
    const total = progress.thumb.ready + thumbPending;
    rows.push({
      key: "thumb",
      label: "Thumbnails",
      detail: `${progress.thumb.ready.toLocaleString()} of ${total.toLocaleString()}`,
    });
  }
  if (progress && tier1Pending > 0) {
    const total = progress.text.ready + tier1Pending;
    rows.push({
      key: "text",
      label: "Reading text",
      detail: `${progress.text.ready.toLocaleString()} of ${total.toLocaleString()}`,
    });
  }
  if (needsOcr > 0) {
    // No denominator: text.ready spans both tiers, so there is no count of how
    // many rows OCR itself has finished to put this against.
    rows.push({ key: "ocr", label: "OCR", detail: `${needsOcr.toLocaleString()} waiting` });
  }

  const busy = rows.length > 0;

  // Same reset LibraryUpdateBanner uses for abortDismissed: a dismissal only
  // covers the work that existed when it was dismissed, not the next lot.
  useEffect(() => {
    if (busy) return;
    setDismissed(false);
  }, [busy]);

  if (!busy || dismissed) return null;

  // One overall time left across whatever is running, and the longest stage is
  // the one being waited on.
  const etaCandidates = [progress?.thumb.etaSeconds, progress?.text.etaSeconds].filter(
    (s): s is number => typeof s === "number",
  );
  const etaSeconds = etaCandidates.length > 0 ? Math.max(...etaCandidates) : null;

  return (
    <div className="flex items-center gap-4 border-b border-border bg-muted/40 px-4 py-2 text-sm text-muted-foreground">
      {rows.map(row => (
        <span key={row.key} className="tabular-nums">
          <span className="font-medium text-foreground">{row.label}</span>{" "}
          {row.detail}
        </span>
      ))}
      {etaSeconds !== null && (
        <span className="tabular-nums">~{formatEta(etaSeconds)} left</span>
      )}
      <button
        type="button"
        onClick={() => setDismissed(true)}
        className="ml-auto shrink-0 rounded p-1 text-muted-foreground/80 hover:bg-muted hover:text-foreground"
        aria-label="Dismiss"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
