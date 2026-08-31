"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { getDerivativeBacklog } from "@/lib/media/backlog";
import type { DerivativeProgress } from "@vault/types";

const BUSY_POLL_MS = 3000;
const IDLE_POLL_MS = 30000;

function hasPending (p: DerivativeProgress | null): boolean {
  return !!p && (p.thumb.pending > 0 || p.text.pending > 0);
}

interface DerivativeProgressContextType {
  /** Null before the first successful poll, or if the endpoint is unreachable. */
  progress: DerivativeProgress | null;
}

const DerivativeProgressContext = createContext<DerivativeProgressContextType | undefined>(undefined);

/**
 * Polls GET /api/server/backlog globally so the readout survives navigation
 * and agrees across tabs (the rate/ETA are computed server-side for this
 * reason). 3 s while anything is pending, 30 s once the backlog is
 * empty — a self-rescheduling timeout rather than setInterval so the cadence
 * can change between ticks without two polls ever overlapping.
 */
export function DerivativeProgressProvider ({ children }: { children: ReactNode }) {
  const [progress, setProgress] = useState<DerivativeProgress | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const next = await getDerivativeBacklog();
      if (cancelled) return;
      setProgress(next);
      timerRef.current = setTimeout(() => void tick(), hasPending(next) ? BUSY_POLL_MS : IDLE_POLL_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return (
    <DerivativeProgressContext.Provider value={{ progress }}>
      {children}
    </DerivativeProgressContext.Provider>
  );
}

export function useDerivativeProgress () {
  const ctx = useContext(DerivativeProgressContext);
  if (ctx === undefined) {
    throw new Error("useDerivativeProgress must be used within a DerivativeProgressProvider");
  }
  return ctx;
}
