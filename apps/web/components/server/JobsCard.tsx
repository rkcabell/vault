"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/Dialog";
import { toast } from "@/components/ui/Toaster";
import { Loader2, Pause, Play, OctagonX } from "lucide-react";
import {
  getJobQueues,
  cancelScan,
  stopAllProcessing,
  resumeProcessing,
  QUEUE_LABELS,
  type JobQueuesState,
} from "@/lib/media/jobs";

const POLL_MS = 3000;

/**
 * Queue depths plus the two stop controls. They are separate because they mean
 * different things: cancelling a scan stops finding new files, while stopping
 * all processing also pauses work on files already found.
 */
export function JobsCard () {
  const [state, setState] = useState<JobQueuesState | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<"cancel" | "stop" | "resume" | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const refresh = useCallback(async () => {
    const next = await getJobQueues();
    setState(next);
    setLoaded(true);
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const run = async (
    action: "cancel" | "stop" | "resume",
    fn: () => Promise<boolean>,
    okMessage: string,
  ) => {
    setBusy(action);
    const ok = await fn();
    // Refresh before clearing busy so the numbers move in the same frame the
    // button re-enables, rather than a poll interval later.
    await refresh();
    setBusy(null);
    toast(ok ? okMessage : "That didn't go through. Check the server logs.", {
      variant: ok ? "success" : "error",
    });
  };

  const paused = state?.derivativesPaused === true;
  const feederOff = state !== null && !state.feederEnabled;
  const scanning = (state?.queues.index?.pending ?? 0) + (state?.queues.reconcile?.pending ?? 0) > 0;

  return (
    <Card>
      <CardHeader className="pb-4">
        <CardTitle>Background jobs</CardTitle>
        <CardDescription className="mt-1">
          What Vault is working through right now, and how to stop it.
        </CardDescription>
      </CardHeader>
      <CardContent className="px-6 pb-6 pt-0 space-y-4">
        {!loaded ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : state === null ? (
          <p className="text-sm text-destructive">Could not read the queues.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="pb-1.5 font-medium">Queue</th>
                  <th className="pb-1.5 pl-4 text-right font-medium">Waiting</th>
                  <th className="pb-1.5 pl-4 text-right font-medium">Running</th>
                  <th className="pb-1.5 pl-4 text-right font-medium">Failed</th>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {QUEUE_LABELS.map(([key, label]) => {
                  const depth = state.queues[key];
                  return (
                    <tr key={key} className="border-t border-border">
                      <td className="py-1.5">{label}</td>
                      <td className="py-1.5 pl-4 text-right">{depth ? depth.waiting.toLocaleString() : "—"}</td>
                      <td className="py-1.5 pl-4 text-right">{depth ? depth.active.toLocaleString() : "—"}</td>
                      <td className={`py-1.5 pl-4 text-right ${depth && depth.failed > 0 ? "text-destructive" : ""}`}>
                        {depth ? depth.failed.toLocaleString() : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* The backlog lives in Postgres, not here — see the derivative feeder.
            Without this the near-empty queues read as "nothing left to do". */}
        <p className="text-xs text-muted-foreground">
          These are the jobs handed to Redis right now, not the whole backlog. Vault keeps only a
          working set in the queues and pulls more from the database as they drain.
        </p>

        {paused && (
          <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm" role="status">
            Processing is paused. Thumbnails and text extraction are on hold until you resume.
          </div>
        )}

        {feederOff && (
          <div className="rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive" role="status">
            Derivative processing is disabled by configuration
            (<code className="font-mono text-xs">DERIVATIVE_FEED_ENABLED=false</code>). Resume cannot
            override that — change it where the server&apos;s environment is set.
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={busy !== null || !scanning}
            onClick={() => void run("cancel", cancelScan, "Scan cancelled.")}
            className="gap-1.5"
          >
            {busy === "cancel" ? <Loader2 className="h-4 w-4 animate-spin" /> : <OctagonX className="h-4 w-4" />}
            Cancel scan
          </Button>

          {paused ? (
            <Button
              size="sm"
              disabled={busy !== null || feederOff}
              onClick={() => void run("resume", resumeProcessing, "Processing resumed.")}
              className="gap-1.5"
            >
              {busy === "resume" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              Resume processing
            </Button>
          ) : (
            <Button
              variant="destructive"
              size="sm"
              disabled={busy !== null}
              onClick={() => setConfirmOpen(true)}
              className="gap-1.5"
            >
              {busy === "stop" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Pause className="h-4 w-4" />}
              Stop all processing
            </Button>
          )}
        </div>

        <p className="text-xs text-muted-foreground">
          <strong className="font-medium text-foreground">Cancel scan</strong> stops looking for new
          files; anything already found keeps processing.{" "}
          <strong className="font-medium text-foreground">Stop all processing</strong> also pauses
          thumbnails, text extraction and hashing. Neither deletes anything, and nothing is lost —
          the backlog waits in the database.
        </p>
      </CardContent>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Stop all processing?</DialogTitle>
            <DialogDescription>
              Indexing stops, and thumbnails, text extraction and hashing pause until you resume.
              Nothing is deleted and no work is lost — the backlog stays in the database and picks up
              where it left off.
            </DialogDescription>
          </DialogHeader>
          {/* The caveat the item asked to surface: there is no admin role to
              restrict this to, so the dialog has to state the blast radius. */}
          <p className="text-sm text-muted-foreground">
            The job queues are shared across the whole server. If anyone else uses this Vault, this
            stops their processing too.
          </p>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                setConfirmOpen(false);
                void run("stop", stopAllProcessing, "All processing stopped.");
              }}
            >
              Stop everything
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
