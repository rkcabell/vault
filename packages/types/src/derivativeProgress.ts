/**
 * Wire format for GET /api/server/backlog — per-derivative progress for the
 * persistent backlog strip. Shared so the API route and the web client's
 * poller agree on the shape.
 */

export type DerivativeStageProgress = {
  pending: number;
  ready: number;
  /** Completions/sec over a trailing window. Null until there are at least
   *  two samples to compare — never a fabricated number on a fresh read. */
  ratePerSec: number | null;
  /** pending / ratePerSec. Null whenever ratePerSec is null, is <= 0, or
   *  pending is 0 — an idle queue shows no ETA rather than "0s remaining". */
  etaSeconds: number | null;
};

export type DerivativeProgress = {
  thumb: DerivativeStageProgress;
  /** pending here is tier-1 (native extraction) only — usually near zero.
   *  The deferred tier-2 backlog is `needsOcr`, tracked separately since it's
   *  the number a user decides whether to pay for. */
  text: DerivativeStageProgress;
  needsOcr: number;
};
