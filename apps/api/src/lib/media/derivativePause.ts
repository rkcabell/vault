/**
 * Pauses all derivative work: thumbnails, text and hashing. The feeder is the
 * only thing that puts those jobs into Redis, so stopping it stops all of them.
 * The flag is kept in Redis, so a pause survives an API restart.
 *
 * `DERIVATIVE_FEED_ENABLED=false` is a separate, deploy-time switch that skips
 * building the feeder at all. This flag never applies in that case.
 */
export const DERIVATIVE_PAUSE_KEY = "vault:derivatives:paused";

/** Minimal Redis surface used here — satisfied by ioredis and by test fakes. */
export type PauseRedis = {
  set(key: string, value: string): Promise<unknown>;
  del(key: string): Promise<unknown>;
  get(key: string): Promise<string | null>;
};

export function pauseDerivatives (redis: Pick<PauseRedis, "set">): Promise<unknown> {
  return redis.set(DERIVATIVE_PAUSE_KEY, "1");
}

export function resumeDerivatives (redis: Pick<PauseRedis, "del">): Promise<unknown> {
  return redis.del(DERIVATIVE_PAUSE_KEY);
}

/** True while derivative work is paused. False when Redis cannot be read, so a
 *  Redis failure alone cannot halt every derivative in the install. */
export async function isDerivativesPaused (redis: Pick<PauseRedis, "get">): Promise<boolean> {
  try {
    return (await redis.get(DERIVATIVE_PAUSE_KEY)) !== null;
  } catch {
    return false;
  }
}
