/**
 * Cross-process kill switch for in-flight bulk delete jobs.
 *
 * A bulk delete walks the library in chunks in the worker; removing the queued
 * job can't stop a delete that's already running. So an abort must also tell the
 * running job to stop between chunks.
 *
 * The signal is a monotonic counter in Redis. The API bumps it on abort; each
 * delete job reads it once at start and re-reads it between chunks. 
 * 
 * If the counter advanced, a newer abort was requested *after* this job began, so the
 * job stops deleting.
 * 
 * Abort ends exactly "all deletes started before now".
 */
export const DELETE_ABORT_EPOCH_KEY = "vault:delete:abort-epoch";

/** Minimal Redis surface used here — satisfied by ioredis and by test fakes. */
export type AbortRedis = {
  incr(key: string): Promise<number>;
  get(key: string): Promise<string | null>;
};

/** Bump the epoch so every delete job that started before now aborts. Returns the new epoch. */
export function signalDeleteAbort (redis: Pick<AbortRedis, "incr">): Promise<number> {
  return redis.incr(DELETE_ABORT_EPOCH_KEY);
}

/** Read the current epoch (0 when never set or unparseable). */
export async function readDeleteAbortEpoch (redis: Pick<AbortRedis, "get">): Promise<number> {
  const raw = await redis.get(DELETE_ABORT_EPOCH_KEY);
  const n = raw ? Number.parseInt(raw, 10) : 0;
  return Number.isFinite(n) ? n : 0;
}
