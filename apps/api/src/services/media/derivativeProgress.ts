import type { DerivativeProgress, DerivativeStageProgress } from "@vault/types";
import type { DerivativeProgressCounts } from "../../repositories/mediaRepository.js";

/**
 * Tracks how fast thumbnails and text extractions are completing, and estimates
 * when the backlog will clear. Rates are measured on the server from one sample
 * buffer per user, so the readout survives a reload and agrees across tabs.
 */

type Sample = { t: number; thumbReady: number; textReady: number };

type UserBuffer = {
  samples: Sample[];
  lastCounts: DerivativeProgressCounts;
  lastFetchAt: number;
  lastReadAt: number;
};

const DEFAULT_SAMPLE_INTERVAL_MS = 5_000;
const DEFAULT_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_PRUNE_AFTER_MS = 10 * 60 * 1000;

export type DerivativeProgressTrackerDeps = {
  repository: { countDerivativeProgress: (userId: string) => Promise<DerivativeProgressCounts> };
  now?: () => number;
  /** Minimum gap between database reads for the same user. A read inside the gap
   *  returns the counts fetched last. */
  sampleIntervalMs?: number;
  /** Trailing window the completion rate is computed over. */
  windowMs?: number;
  /** A user's samples are dropped once nothing has read them for this long. */
  pruneAfterMs?: number;
};

export type DerivativeProgressTracker = { read: (userId: string) => Promise<DerivativeProgress> };

export function createDerivativeProgressTracker (deps: DerivativeProgressTrackerDeps): DerivativeProgressTracker {
  const now = deps.now ?? (() => Date.now());
  const sampleIntervalMs = deps.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS;
  const windowMs = deps.windowMs ?? DEFAULT_WINDOW_MS;
  const pruneAfterMs = deps.pruneAfterMs ?? DEFAULT_PRUNE_AFTER_MS;

  const buffers = new Map<string, UserBuffer>();

  const prune = (t: number) => {
    const cutoff = t - pruneAfterMs;
    for (const [userId, buf] of buffers) {
      if (buf.lastReadAt < cutoff) buffers.delete(userId);
    }
  };

  /** Returns completions per second across the buffered window. Null with fewer
   *  than two samples, or when no time separates the oldest and newest. */
  const rateOf = (samples: Sample[], key: "thumbReady" | "textReady"): number | null => {
    if (samples.length < 2) return null;
    const oldest = samples[0];
    const newest = samples[samples.length - 1];
    const dtSeconds = (newest.t - oldest.t) / 1000;
    if (dtSeconds <= 0) return null;
    return (newest[key] - oldest[key]) / dtSeconds;
  };

  const etaOf = (pending: number, ratePerSec: number | null): number | null => {
    if (ratePerSec === null || ratePerSec <= 0 || pending <= 0) return null;
    return pending / ratePerSec;
  };

  const stage = (samples: Sample[], key: "thumbReady" | "textReady", pending: number, ready: number): DerivativeStageProgress => {
    const ratePerSec = rateOf(samples, key);
    return { pending, ready, ratePerSec, etaSeconds: etaOf(pending, ratePerSec) };
  };

  const read = async (userId: string): Promise<DerivativeProgress> => {
    const t = now();
    prune(t);

    let buf = buffers.get(userId);

    if (!buf || t - buf.lastFetchAt >= sampleIntervalMs) {
      const counts = await deps.repository.countDerivativeProgress(userId);
      const samples = buf?.samples ?? [];
      samples.push({ t, thumbReady: counts.thumb.ready, textReady: counts.text.ready });
      const windowStart = t - windowMs;
      while (samples.length > 1 && samples[0].t < windowStart) samples.shift();
      buf = { samples, lastCounts: counts, lastFetchAt: t, lastReadAt: t };
      buffers.set(userId, buf);
    } else {
      buf.lastReadAt = t;
    }

    const counts = buf.lastCounts;
    return {
      thumb: stage(buf.samples, "thumbReady", counts.thumb.pending, counts.thumb.ready),
      // Rows awaiting OCR are still outstanding, and the sampled rate counts
      // READY arrivals from both tiers, so the ETA must include them.
      text: stage(buf.samples, "textReady", counts.text.pending + counts.text.needsOcr, counts.text.ready),
      needsOcr: counts.text.needsOcr,
    };
  };

  return { read };
}
