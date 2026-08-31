"use client";

import {
  createContext, useCallback, useContext, useEffect, useRef, useState,
  type ReactNode,
} from "react";
import {
  startIndex, stopIndex, getIndexStatus, getActiveIndex, type IndexStatus,
} from "@/lib/media/indexing";
import { emitTagsUpdated } from "@/lib/tags";
import { toast } from "@/components/ui/Toaster";

const POLL_MS = 1500;
// Coalesce the live sidebar refreshes so a fast scan doesn't hammer /api/tags.
const TAG_REFRESH_DEBOUNCE_MS = 1000;

function isTerminal (s: IndexStatus | null): boolean {
  return !!s && (s.done || s.state === "failed");
}

interface IndexProgressContextType {
  /** The in-flight (or most recently finished, this session) scan, or null. */
  status: IndexStatus | null;
  /** Kick off a scan and begin tracking it. Throws if the API rejects the start. */
  start: (path: string, recursive: boolean) => Promise<void>;
  /** Stop the directory walker without clearing already-enqueued thumb/OCR jobs. */
  stop: () => Promise<void>;
}

const IndexProgressContext = createContext<IndexProgressContextType | undefined>(undefined);

/**
 * Tracks the user's directory scan globally so progress survives navigation and
 * page reloads: on mount it re-attaches to any in-flight job, polls it to
 * completion, and live-refreshes the tag sidebar as new files are indexed.
 */
export function IndexProgressProvider ({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<IndexStatus | null>(null);
  const jobIdRef = useRef<string | null>(null);
  const prevIndexedRef = useRef(0);
  const tagDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastedJobRef = useRef<string | null>(null);

  const scheduleTagRefresh = useCallback(() => {
    if (tagDebounceRef.current) return; // a refresh is already pending within the window
    tagDebounceRef.current = setTimeout(() => {
      tagDebounceRef.current = null;
      emitTagsUpdated();
    }, TAG_REFRESH_DEBOUNCE_MS);
  }, []);

  const applyStatus = useCallback((next: IndexStatus | null) => {
    setStatus(next);
    if (!next) return;

    // Indexed count went up since the last poll → refresh the sidebar (debounced).
    if (next.indexed > prevIndexedRef.current) {
      prevIndexedRef.current = next.indexed;
      scheduleTagRefresh();
    }

    // Fire the completion side effects once per job.
    if (isTerminal(next) && toastedJobRef.current !== next.jobId) {
      toastedJobRef.current = next.jobId;
      emitTagsUpdated(); // final reconcile, no debounce
      if (next.state === "failed") {
        toast("Indexing failed. Check the server logs.", { variant: "error" });
      } else {
        toast(
          `Indexed ${next.indexed} file${next.indexed === 1 ? "" : "s"} (${next.filtered} filtered, ${next.skipped} skipped).`,
          { variant: "success" },
        );
      }
    }
  }, [scheduleTagRefresh]);

  // Re-attach to an in-flight scan on mount (survives reload).
  useEffect(() => {
    let cancelled = false;
    void getActiveIndex().then(active => {
      if (cancelled || !active) return;
      jobIdRef.current = active.jobId;
      prevIndexedRef.current = active.indexed;
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
      void getIndexStatus(jobId).then(s => { if (s) applyStatus(s); });
    }, POLL_MS);
    return () => clearInterval(id);
  }, [status, applyStatus]);

  useEffect(() => () => { if (tagDebounceRef.current) clearTimeout(tagDebounceRef.current); }, []);

  const start = useCallback(async (path: string, recursive: boolean) => {
    const { jobId } = await startIndex(path, recursive);
    jobIdRef.current = jobId;
    prevIndexedRef.current = 0;
    toastedJobRef.current = null;
    applyStatus({
      jobId, state: "active", done: false, aborted: false,
      scanned: 0, indexed: 0, skipped: 0, filtered: 0,
    });
  }, [applyStatus]);

  const stop = useCallback(async () => {
    await stopIndex();
  }, []);

  return (
    <IndexProgressContext.Provider value={{ status, start, stop }}>
      {children}
    </IndexProgressContext.Provider>
  );
}

export function useIndexProgress () {
  const ctx = useContext(IndexProgressContext);
  if (ctx === undefined) {
    throw new Error("useIndexProgress must be used within an IndexProgressProvider");
  }
  return ctx;
}
