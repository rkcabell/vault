import type { SidecarRestoreState } from "@vault/types";

/**
 * Redis keys, types, and store for tracking a metadata restore. The state key
 * records the restore's most recent progress or outcome. The lock key marks a
 * restore as running, and admits only one restore per user at a time.
 */

export const restoreStateKey = (userId: string) => `vault:sidecar:restore:state:${userId}`;
export const restoreLockKey = (userId: string) => `vault:sidecar:restore:lock:${userId}`;

/** Must outlast a single restore chunk, and must expire quickly enough that a
 *  crashed process stops blocking `startRestore`. */
export const RESTORE_LOCK_TTL_SECONDS = 120;

/** How long a finished restore stays readable for reporting. */
export const RESTORE_STATE_TTL_SECONDS = 30 * 24 * 60 * 60;

export type RunningState = Extract<SidecarRestoreState, { state: "running" }>;
export type TerminalState = Extract<SidecarRestoreState, { state: "done" | "failed" }>;

/** The Redis methods this file uses. Both ioredis and the test fakes satisfy it. */
export type RestoreRedis = {
  set(key: string, value: string, ex: "EX", seconds: number, nx: "NX"): Promise<"OK" | null>;
  set(key: string, value: string, ex: "EX", seconds: number): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<unknown>;
  expire(key: string, seconds: number): Promise<unknown>;
};

/** Injected into the sidecar service. Tests pass an in-memory implementation. */
export type RestoreStore = {
  /** True when this call claimed the lock, false when a restore already holds
   *  it. Claiming must be a single atomic operation. */
  acquire(userId: string, state: RunningState): Promise<boolean>;
  /** Records progress and extends the lock's expiry. */
  heartbeat(userId: string, state: RunningState): Promise<void>;
  /** Records the outcome and releases the lock. */
  finish(userId: string, state: TerminalState): Promise<void>;
  /** Returns the last reported state. A restore whose lock has expired reads
   *  back as interrupted. */
  read(userId: string): Promise<SidecarRestoreState | null>;
  isRunning(userId: string): Promise<boolean>;
};

export function createRedisRestoreStore (redis: RestoreRedis): RestoreStore {
  const writeState = (userId: string, state: SidecarRestoreState) =>
    redis.set(restoreStateKey(userId), JSON.stringify(state), "EX", RESTORE_STATE_TTL_SECONDS);

  return {
    async acquire (userId, state) {
      // Setting the key and testing it must be one operation. Otherwise two
      // requests arriving together both start a restore.
      const claimed = await redis.set(restoreLockKey(userId), state.startedAt, "EX", RESTORE_LOCK_TTL_SECONDS, "NX");
      if (claimed === null) return false;
      await writeState(userId, state);
      return true;
    },

    async heartbeat (userId, state) {
      await writeState(userId, state);
      // EXPIRE extends the lock only if it still exists. Re-creating an expired
      // lock would overwrite the process that took it.
      await redis.expire(restoreLockKey(userId), RESTORE_LOCK_TTL_SECONDS);
    },

    async finish (userId, state) {
      await writeState(userId, state);
      await redis.del(restoreLockKey(userId));
    },

    async read (userId) {
      try {
        const raw = await redis.get(restoreStateKey(userId));
        if (raw === null) return null;
        const state = JSON.parse(raw) as SidecarRestoreState;
        if (state.state !== "running") return state;
        if (await redis.get(restoreLockKey(userId)) !== null) return state;
        return { state: "interrupted", startedAt: state.startedAt, processed: state.processed };
      } catch {
        // An unreadable state reports as no state, so the settings page still
        // renders. getStatus treats a corrupt snapshot the same way.
        return null;
      }
    },

    async isRunning (userId) {
      try {
        return (await redis.get(restoreLockKey(userId))) !== null;
      } catch {
        // Reports a restore as running when Redis cannot be reached. A skipped
        // export runs again at the next interval; an export taken during a
        // restore would write a snapshot of a half-restored library.
        return true;
      }
    },
  };
}
