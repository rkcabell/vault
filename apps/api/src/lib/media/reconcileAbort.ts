/**
 * Stops reconcile sweeps that are already running: draining `reconcile_queue`
 * removes only the queued ones. The signal is a counter in Redis that the API
 * raises and each sweep re-reads as it works. Reconcile keeps a counter of its
 * own, so stopping a sweep does not also cancel an index scan.
 */
export const RECONCILE_ABORT_EPOCH_KEY = "vault:reconcile:abort-epoch";

/** Minimal Redis surface used here — satisfied by ioredis and by test fakes. */
export type AbortRedis = {
  incr(key: string): Promise<number>;
  get(key: string): Promise<string | null>;
};

/** Raises the epoch, stopping every reconcile sweep that started before now.
 *  Returns the new epoch. */
export function signalReconcileAbort (redis: Pick<AbortRedis, "incr">): Promise<number> {
  return redis.incr(RECONCILE_ABORT_EPOCH_KEY);
}

/** Reads the current epoch. Zero when it was never set, or cannot be parsed. */
export async function readReconcileAbortEpoch (redis: Pick<AbortRedis, "get">): Promise<number> {
  const raw = await redis.get(RECONCILE_ABORT_EPOCH_KEY);
  const n = raw ? Number.parseInt(raw, 10) : 0;
  return Number.isFinite(n) ? n : 0;
}
