"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { Loader2 } from "lucide-react";
import { useIndexProgress } from "@/components/contexts/IndexProgressContext";
import { useDeleteProgress } from "@/components/contexts/DeleteProgressContext";
import { emitTagsUpdated } from "@/lib/tags";
import { toast } from "@/components/ui/Toaster";

// Hard-stop the background queues. Development/testing only; absent in prod builds.
const DevAbortButton =
  process.env.NODE_ENV === "development"
    ? dynamic(() => import("@/components/dev/DevAbortButton"))
    : null;

/**
 * Ephemeral Library banner that surfaces live background work — directory-scan
 * walk counts and bulk-delete progress. The upload page's own counter unmounts
 * on navigation, so this keeps progress visible while browsing. Renders nothing
 * unless something is active or recently finished; both rows can show at once.
 *
 * Delete row lingers 3 s after completion so fast deletes are visible rather
 * than flashing at "0" and immediately disappearing.
 */
export function LibraryUpdateBanner() {
  const { status: index } = useIndexProgress();
  const { status: del, abort } = useDeleteProgress();

  const [abortDismissed, setAbortDismissed] = useState(false);

  // Reset dismissal when a new indexing job starts.
  const indexJobId = index?.jobId;
  useEffect(() => { setAbortDismissed(false); }, [indexJobId]);

  // Capture the final deleted count so the done row can display it even after
  // the context status clears or a new job begins.
  const [doneRow, setDoneRow] = useState<{ deleted: number; jobId: string } | null>(null);
  const doneTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!del) return;
    if (!del.done) {
      // New or in-progress delete: clear any lingering done row immediately.
      if (doneTimerRef.current) clearTimeout(doneTimerRef.current);
      setDoneRow(null);
      return;
    }
    if (del.state === "failed" || del.aborted) return;
    // Transition to done: capture count, schedule hide after 3 s.
    setDoneRow({ deleted: del.deleted, jobId: del.jobId });
    if (doneTimerRef.current) clearTimeout(doneTimerRef.current);
    doneTimerRef.current = setTimeout(() => setDoneRow(null), 3000);
  }, [del]);

  useEffect(() => () => { if (doneTimerRef.current) clearTimeout(doneTimerRef.current); }, []);

  const indexing = index && !index.done && index.state !== "failed" && !abortDismissed;
  const deleting = del && !del.done && del.state !== "failed";
  const showDone = doneRow !== null;

  if (!indexing && !deleting && !showDone) return null;

  return (
    <div className="mb-4 flex flex-col gap-1.5">
      {indexing && (
        <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-4 py-2.5 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
          <span className="tabular-nums">
            Indexing…{" "}
            <strong className="font-medium text-foreground">{index.scanned.toLocaleString()}</strong> scanned ·{" "}
            <strong className="font-medium text-foreground">{index.indexed.toLocaleString()}</strong> indexed ·{" "}
            {index.filtered.toLocaleString()} filtered
          </span>
          {DevAbortButton && (
            <div className="ml-auto shrink-0">
              <DevAbortButton
                onAbortStart={() => setAbortDismissed(true)}
                onSuccess={() => emitTagsUpdated()}
                onError={(message) => toast(message, { variant: "error" })}
              />
            </div>
          )}
        </div>
      )}

      {(deleting || showDone) && (
        <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-4 py-2.5 text-sm text-muted-foreground">
          {deleting ? (
            <>
              <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
              <span className="tabular-nums">
                Deleting…{" "}
                <strong className="font-medium text-foreground">{del.deleted.toLocaleString()}</strong>
                {del.total ? <> / {del.total.toLocaleString()}</> : null}
              </span>
              <button
                type="button"
                onClick={() => void abort()}
                className="ml-auto rounded px-1.5 py-0.5 text-muted-foreground/80 hover:text-foreground hover:bg-muted"
                aria-label="Stop deleting"
              >
                Stop
              </button>
            </>
          ) : (
            <span>
              Deleted{" "}
              <strong className="font-medium text-foreground">{doneRow!.deleted.toLocaleString()}</strong>{" "}
              {doneRow!.deleted === 1 ? "item" : "items"}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
