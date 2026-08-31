import test from "node:test";
import assert from "node:assert/strict";
import {
  DERIVATIVE_PAUSE_KEY,
  isDerivativesPaused,
  pauseDerivatives,
  resumeDerivatives,
} from "@/lib/media/derivativePause.js";

/** An in-memory stand-in for the one Redis key this module owns. */
function makeRedis (initial?: string) {
  const store = new Map<string, string>();
  if (initial !== undefined) store.set(DERIVATIVE_PAUSE_KEY, initial);
  return {
    store,
    set: async (key: string, value: string) => { store.set(key, value); return "OK"; },
    del: async (key: string) => (store.delete(key) ? 1 : 0),
    get: async (key: string) => store.get(key) ?? null,
  };
}

test("derivativePause: pause then resume round-trips", async () => {
  const redis = makeRedis();

  assert.equal(await isDerivativesPaused(redis), false);
  await pauseDerivatives(redis);
  assert.equal(await isDerivativesPaused(redis), true);
  await resumeDerivatives(redis);
  assert.equal(await isDerivativesPaused(redis), false);
});

test("derivativePause: resume is idempotent when nothing was paused", async () => {
  const redis = makeRedis();

  await resumeDerivatives(redis);

  assert.equal(await isDerivativesPaused(redis), false);
});

test("derivativePause: an unreadable Redis reports not-paused", async () => {
  const redis = { get: async () => { throw new Error("connection refused"); } };

  // Fail open deliberately: a Redis blip must not be able to halt every
  // derivative in the install on its own.
  assert.equal(await isDerivativesPaused(redis), false);
});
