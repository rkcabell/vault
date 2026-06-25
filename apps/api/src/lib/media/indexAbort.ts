/**
 * Cross-process kill switch for in-flight index walks.
 *
 * Draining the BullMQ queues only removes *already-enqueued* jobs — it can't
 * stop the index worker, which walks the filesystem in memory and keeps adding
 * thumb/OCR jobs as it goes. So a dev "abort" must also tell that walk to stop.
 *
 * The signal is a monotonic counter in Redis. The API bumps it on abort; each
 * index walk reads it once at start and re-reads it between batches. If the
 * counter advanced, a newer abort was requested *after* this walk began, so the
 * walk stops enqueuing. Walks started after the bump capture the new value and
 * run normally — i.e. abort ends exactly "all indexing started before now".
 */
export const INDEX_ABORT_EPOCH_KEY = "vault:index:abort-epoch";

/** Minimal Redis surface used here — satisfied by ioredis and by test fakes. */
export type AbortRedis = {
  incr(key: string): Promise<number>;
  get(key: string): Promise<string | null>;
};

/** Bump the epoch so every index walk that started before now aborts. Returns the new epoch. */
export function signalIndexAbort (redis: Pick<AbortRedis, "incr">): Promise<number> {
  return redis.incr(INDEX_ABORT_EPOCH_KEY);
}

/** Read the current epoch (0 when never set or unparseable). */
export async function readIndexAbortEpoch (redis: Pick<AbortRedis, "get">): Promise<number> {
  const raw = await redis.get(INDEX_ABORT_EPOCH_KEY);
  const n = raw ? Number.parseInt(raw, 10) : 0;
  return Number.isFinite(n) ? n : 0;
}
