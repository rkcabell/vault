"use client";

import {
  createContext, useCallback, useContext, useEffect, useRef, useState,
  type ReactNode,
} from "react";
import {
  startBulkDelete, getDeleteStatus, getActiveDelete, abortBulkDelete,
  type DeleteStatus,
} from "@/lib/media/deleting";
import { emitTagsUpdated } from "@/lib/tags";
import { emitBundlesUpdated } from "@/lib/bundles";
import { toast } from "@/components/ui/Toaster";

const POLL_MS = 1500;

function isTerminal (s: DeleteStatus | null): boolean {
  return !!s && (s.done || s.state === "failed");
}

interface DeleteProgressContextType {
  /** The in-flight (or most recently finished, this session) delete, or null. */
  status: DeleteStatus | null;
  /** Enqueue a bulk delete and begin tracking it. Returns the jobId. Throws if the API rejects it. */
  start: (input: { ids: string[] } | { query: string }) => Promise<{ jobId: string }>;
  /** Stop the in-flight delete. */
  abort: () => Promise<void>;
}

const DeleteProgressContext = createContext<DeleteProgressContextType | undefined>(undefined);

/**
 * Tracks the user's bulk delete globally so progress survives navigation and
 * page reloads: on mount it re-attaches to any in-flight job, polls it to
 * completion, and fires the tag/bundle sidebar refreshes when it finishes.
 */
export function DeleteProgressProvider ({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<DeleteStatus | null>(null);
  const jobIdRef = useRef<string | null>(null);
  const toastedJobRef = useRef<string | null>(null);

  const applyStatus = useCallback((next: DeleteStatus | null) => {
    setStatus(next);
    if (!next) return;

    // Fire the completion side effects exactly once per job.
    if (isTerminal(next) && toastedJobRef.current !== next.jobId) {
      toastedJobRef.current = next.jobId;
      emitTagsUpdated();
      emitBundlesUpdated();
      if (next.state === "failed") {
        toast("Delete failed. Check the server logs.", { variant: "error" });
      } else if (next.aborted) {
        toast(`Delete stopped — removed ${next.deleted} of ${next.total}.`, { variant: "default" });
      } else {
        toast(
          `Deleted ${next.deleted} item${next.deleted === 1 ? "" : "s"}.`,
          { variant: "success" },
        );
      }
    }
  }, []);

  // Re-attach to an in-flight delete on mount (survives reload).
  useEffect(() => {
    let cancelled = false;
    void getActiveDelete().then(active => {
      if (cancelled || !active) return;
      jobIdRef.current = active.jobId;
      applyStatus(active);
    });
    return () => { cancelled = true; };
  }, [applyStatus]);

  // Poll while a job is attached and still running.
  useEffect(() => {
    if (!status || isTerminal(status)) return;
    const id = setInterval(() => {
      const jobId = jobIdRef.current;
      if (!jobId) return;
      void getDeleteStatus(jobId).then(s => { if (s) applyStatus(s); });
    }, POLL_MS);
    return () => clearInterval(id);
  }, [status, applyStatus]);

  const start = useCallback(async (input: { ids: string[] } | { query: string }) => {
    const { jobId } = await startBulkDelete(input);
    jobIdRef.current = jobId;
    toastedJobRef.current = null;
    const total = "ids" in input ? input.ids.length : 0;
    applyStatus({ jobId, state: "active", done: false, aborted: false, total, deleted: 0, failed: 0 });
    return { jobId };
  }, [applyStatus]);

  const abort = useCallback(async () => {
    await abortBulkDelete();
  }, []);

  return (
    <DeleteProgressContext.Provider value={{ status, start, abort }}>
      {children}
    </DeleteProgressContext.Provider>
  );
}

export function useDeleteProgress () {
  const ctx = useContext(DeleteProgressContext);
  if (ctx === undefined) {
    throw new Error("useDeleteProgress must be used within a DeleteProgressProvider");
  }
  return ctx;
}
