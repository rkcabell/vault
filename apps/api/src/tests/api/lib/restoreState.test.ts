import test from "node:test";
import assert from "node:assert/strict";
import {
  RESTORE_LOCK_TTL_SECONDS,
  createRedisRestoreStore,
  restoreLockKey,
  restoreStateKey,
  type RestoreRedis,
  type RunningState,
} from "@/lib/sidecar/restoreState.js";

/** In-memory stand-in with just enough SET NX / EXPIRE semantics. Expiry is
 *  manual: `lapse` stands in for a TTL running out. */
function makeRedis () {
  const values = new Map<string, string>();
  const ttl = new Map<string, number>();
  const redis = {
    set: async (key: string, value: string, _ex: "EX", seconds: number, nx?: "NX") => {
      if (nx === "NX" && values.has(key)) return null;
      values.set(key, value);
      ttl.set(key, seconds);
      return "OK";
    },
    get: async (key: string) => values.get(key) ?? null,
    del: async (key: string) => {
      ttl.delete(key);
      return values.delete(key) ? 1 : 0;
    },
    expire: async (key: string, seconds: number) => {
      if (!values.has(key)) return 0;
      ttl.set(key, seconds);
      return 1;
    },
  } as unknown as RestoreRedis;

  return {
    redis,
    values,
    ttl,
    lapse: (key: string) => { values.delete(key); ttl.delete(key); },
  };
}

const RUNNING: RunningState = { state: "running", startedAt: "2026-07-30T10:00:00.000Z", processed: 0 };

test("restoreState: a second acquire is refused while the lock stands", async () => {
  const store = createRedisRestoreStore(makeRedis().redis);

  assert.equal(await store.acquire("u1", RUNNING), true);
  assert.equal(await store.acquire("u1", { ...RUNNING, processed: 5 }), false);
});

test("restoreState: one user's lock does not block another's", async () => {
  const store = createRedisRestoreStore(makeRedis().redis);

  assert.equal(await store.acquire("u1", RUNNING), true);
  assert.equal(await store.acquire("u2", RUNNING), true);
});

test("restoreState: finish records the outcome and frees the lock", async () => {
  const store = createRedisRestoreStore(makeRedis().redis);
  await store.acquire("u1", RUNNING);

  const failed = { state: "failed", finishedAt: "2026-07-30T10:05:00.000Z", message: "disk full" } as const;
  await store.finish("u1", failed);

  assert.equal(await store.isRunning("u1"), false);
  assert.deepEqual(await store.read("u1"), failed);
  assert.equal(await store.acquire("u1", RUNNING), true, "the next restore can start");
});

test("restoreState: a running state with no lock behind it reads as interrupted", async () => {
  const { redis, lapse } = makeRedis();
  const store = createRedisRestoreStore(redis);
  await store.acquire("u1", RUNNING);
  await store.heartbeat("u1", { ...RUNNING, processed: 120 });

  assert.deepEqual(await store.read("u1"), { ...RUNNING, processed: 120 }, "running while the lock lives");

  lapse(restoreLockKey("u1"));

  assert.deepEqual(await store.read("u1"), {
    state: "interrupted",
    startedAt: RUNNING.startedAt,
    processed: 120,
  });
  assert.equal(await store.isRunning("u1"), false, "and no longer blocks a re-run");
});

test("restoreState: heartbeat pushes the lock's expiry back out", async () => {
  const { redis, ttl } = makeRedis();
  const store = createRedisRestoreStore(redis);
  await store.acquire("u1", RUNNING);
  ttl.set(restoreLockKey("u1"), 1);

  await store.heartbeat("u1", { ...RUNNING, processed: 10 });

  assert.equal(ttl.get(restoreLockKey("u1")), RESTORE_LOCK_TTL_SECONDS);
});

test("restoreState: heartbeat does not resurrect a lock that already lapsed", async () => {
  const { redis, lapse } = makeRedis();
  const store = createRedisRestoreStore(redis);
  await store.acquire("u1", RUNNING);
  lapse(restoreLockKey("u1"));

  await store.heartbeat("u1", { ...RUNNING, processed: 10 });

  // EXPIRE on a missing key is a no-op, so a straggling heartbeat cannot take
  // the lock back from whoever claimed it next.
  assert.equal(await store.isRunning("u1"), false);
});

test("restoreState: nothing recorded reads as null", async () => {
  assert.equal(await createRedisRestoreStore(makeRedis().redis).read("u1"), null);
});

test("restoreState: a corrupt state value reads as null rather than throwing", async () => {
  const { redis, values } = makeRedis();
  values.set(restoreStateKey("u1"), "{not json");

  assert.equal(await createRedisRestoreStore(redis).read("u1"), null);
});

test("restoreState: an unreadable Redis reports no restore, but assumes one is running", async () => {
  const redis = {
    get: async () => { throw new Error("connection refused"); },
  } as unknown as RestoreRedis;
  const store = createRedisRestoreStore(redis);

  assert.equal(await store.read("u1"), null);
  // Fails closed, unlike derivativePause: a skipped export costs one interval,
  // an export over a half-restored library corrupts the snapshot.
  assert.equal(await store.isRunning("u1"), true);
});
