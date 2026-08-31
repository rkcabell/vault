"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { toast } from "@/components/ui/Toaster";
import { Loader2, RefreshCw, Square } from "lucide-react";
import { getReconcileState, startReconcile, stopReconcile, type ReconcileStatus } from "@/lib/media/reconcile";

const POLL_MS = 1500;

/** "just now" / "12 minutes ago" / "3 days ago" — enough precision for a sweep
 *  the user runs by hand, without pulling in a date library. */
function timeAgo (epochMs: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - epochMs) / 1000));
  if (seconds < 60) return "just now";
  const units: Array<[number, string]> = [
    [60, "minute"],
    [60, "hour"],
    [24, "day"],
  ];
  let value = seconds;
  let label = "second";
  for (const [factor, name] of units) {
    if (value < factor) break;
    value = Math.floor(value / factor);
    label = name;
  }
  return `${value} ${label}${value === 1 ? "" : "s"} ago`;
}

/** The counters worth showing, in the order a user reads them. Zeroes are
 *  dropped — "0 moved, 0 missing" is noise on a library that did not change. */
function summarize (s: ReconcileStatus): string {
  const parts: Array<[number, string]> = [
    [s.added, "added"],
    [s.moved, "moved"],
    [s.changed, "updated"],
    [s.revived, "restored"],
    [s.missing, "missing"],
  ];
  const shown = parts.filter(([n]) => n > 0).map(([n, label]) => `${n} ${label}`);
  return shown.length > 0 ? shown.join(", ") : "no changes";
}

/** Runs the reconciliation sweep and reports it — see {@link ReconcileStatus}
 *  for what the sweep covers that a scan and the watcher cannot. */
export function ReconcileCheck ({ enabled }: { enabled: boolean }) {
  const [active, setActive] = useState<ReconcileStatus | null>(null);
  const [last, setLast] = useState<ReconcileStatus | null>(null);
  const [starting, setStarting] = useState(false);
  /**
   * A run this tab kicked off is still in flight, so the completion toast fires
   * once and only for a run the user asked for. Deliberately not a jobId: one
   * check enqueues a job per root, and the first job's id is never the
   * last-finished one, which left the flag set and the poll running forever.
   * Mirrored into a ref so reading it cannot re-create `refresh`, which would
   * restart the polling interval every tick.
   */
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const markPending = useCallback((value: boolean) => {
    pendingRef.current = value;
    setPending(value);
  }, []);

  /**
   * `finishedAt` of the newest completed sweep, and the value it had when this
   * tab last pressed the button. A run is done when a *newer* one has finished —
   * "no active job" alone fires the instant we start, before the queue read
   * catches up. Both are server timestamps compared against each other, never
   * against `Date.now()`, so browser clock skew cannot affect the result.
   */
  const lastFinishedAtRef = useRef(0);
  const baselineFinishedAtRef = useRef(0);

  const refresh = useCallback(async () => {
    const state = await getReconcileState();
    if (state === null) return; // unreachable server — keep showing the last good state

    setActive(state.active);
    setLast(state.last);
    lastFinishedAtRef.current = state.last?.finishedAt ?? 0;

    // Kept out of a state updater on purpose — updaters must stay pure, or
    // StrictMode's double-invoke double-toasts.
    const finished = lastFinishedAtRef.current > baselineFinishedAtRef.current;
    if (pendingRef.current && !state.active && finished) {
      markPending(false);
      if (state.last?.state === "failed") {
        toast("The check failed. Check the server logs.", { variant: "error" });
      } else if (state.last) {
        toast(`Check complete — ${summarize(state.last)}.`, { variant: "success" });
      }
    }
  }, [markPending]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Poll while a sweep is running, or while we are waiting for one we started
  // to become visible in the queue.
  useEffect(() => {
    if (!active && !pending) return;
    const id = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(id);
  }, [active, pending, refresh]);

  const handleStart = useCallback(async () => {
    setStarting(true);
    try {
      // Freeze the "newest finished sweep" mark before starting, so completion
      // means strictly newer than whatever the card was already showing.
      baselineFinishedAtRef.current = lastFinishedAtRef.current;
      await startReconcile();
      markPending(true);
      await refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not start the check", { variant: "error" });
    } finally {
      setStarting(false);
    }
  }, [refresh, markPending]);

  const handleStop = useCallback(async () => {
    try {
      await stopReconcile();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not stop the check", { variant: "error" });
    }
    await refresh();
  }, [refresh]);

  // `running` gates the live-progress line, which reads `active`, so it stays
  // strictly "a job is active"; `busy` also covers the gap before the queue
  // reports a check we just started, when a second click must not be inviting.
  const running = active !== null;
  const busy = running || pending || starting;

  return (
    <div className={`space-y-2 ${enabled ? "" : "opacity-50"}`}>
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Check for changes
      </span>
      <p className="text-xs text-muted-foreground">
        Compares your folders against Vault&apos;s library. Finds files that were deleted, moved, or
        edited while Vault was not running — a normal scan only picks up new files.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={handleStart}
          disabled={!enabled || busy}
          className="gap-1.5"
        >
          {busy
            ? <Loader2 className="h-4 w-4 animate-spin" />
            : <RefreshCw className="h-4 w-4" />}
          Check for changes
        </Button>
        {running && (
          <Button size="sm" variant="ghost" onClick={handleStop} className="gap-1.5">
            <Square className="h-3.5 w-3.5" />
            Stop
          </Button>
        )}
      </div>

      {running ? (
        <p className="text-xs text-muted-foreground" role="status">
          Checking {active.rootPath} — {active.checked} item
          {active.checked === 1 ? "" : "s"} verified, {active.scanned} file
          {active.scanned === 1 ? "" : "s"} seen ({summarize(active)}).
        </p>
      ) : last ? (
        <p className="text-xs text-muted-foreground" role="status">
          {last.state === "failed"
            ? `Last check failed ${last.finishedAt ? timeAgo(last.finishedAt) : ""}.`
            : `Last checked ${last.finishedAt ? timeAgo(last.finishedAt) : "recently"} — ${summarize(last)}${last.aborted ? " (stopped early)" : ""}.`}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">Never checked.</p>
      )}
    </div>
  );
}
