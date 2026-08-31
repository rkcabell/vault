/**
 * Stops bulk delete jobs that are already running: removing the queued job
 * cannot stop one mid-run. The signal is a counter in Redis that the API raises
 * and each job re-reads between chunks. A job whose counter has moved since it
 * started stops deleting.
 */
export const DELETE_ABORT_EPOCH_KEY = "vault:delete:abort-epoch";

/** Minimal Redis surface used here — satisfied by ioredis and by test fakes. */
export type AbortRedis = {
  incr(key: string): Promise<number>;
  get(key: string): Promise<string | null>;
};

/** Raises the epoch, stopping every delete job that started before now.
 *  Returns the new epoch. */
export function signalDeleteAbort (redis: Pick<AbortRedis, "incr">): Promise<number> {
  return redis.incr(DELETE_ABORT_EPOCH_KEY);
}

/** Reads the current epoch. Zero when it was never set, or cannot be parsed. */
export async function readDeleteAbortEpoch (redis: Pick<AbortRedis, "get">): Promise<number> {
  const raw = await redis.get(DELETE_ABORT_EPOCH_KEY);
  const n = raw ? Number.parseInt(raw, 10) : 0;
  return Number.isFinite(n) ? n : 0;
}
