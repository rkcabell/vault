/**
 * Stops index walks that are already running. Raising the epoch tells every walk
 * that started earlier to stop adding jobs.
 */

export const INDEX_ABORT_EPOCH_KEY = "vault:index:abort-epoch";

/** Redis methods this module needs — satisfied by ioredis and by test fakes. */
export type AbortRedis = {
  incr(key: string): Promise<number>;
  get(key: string): Promise<string | null>;
};

/** Starts a new abort epoch, ending every index walk that began earlier. */
export function signalIndexAbort (redis: Pick<AbortRedis, "incr">): Promise<number> {
  return redis.incr(INDEX_ABORT_EPOCH_KEY);
}

/** Reads the current abort epoch (0 if never set). */
export async function readIndexAbortEpoch (redis: Pick<AbortRedis, "get">): Promise<number> {
  const raw = await redis.get(INDEX_ABORT_EPOCH_KEY);
  const n = raw ? Number.parseInt(raw, 10) : 0;
  return Number.isFinite(n) ? n : 0;
}
