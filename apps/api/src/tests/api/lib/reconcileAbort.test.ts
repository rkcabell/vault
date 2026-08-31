import test from "node:test";
import assert from "node:assert/strict";
import {
  signalReconcileAbort,
  readReconcileAbortEpoch,
  RECONCILE_ABORT_EPOCH_KEY,
} from "@/lib/media/reconcileAbort.js";

/** Tiny in-memory stand-in for the bits of ioredis we use. */
function makeRedis (initial: string | null = null) {
  let value = initial;
  return {
    incr: async () => { const n = (value ? parseInt(value, 10) : 0) + 1; value = String(n); return n; },
    get: async () => value,
  };
}

test("signalReconcileAbort increments and returns the new epoch", async () => {
  const r = makeRedis();
  assert.equal(await signalReconcileAbort(r), 1);
  assert.equal(await signalReconcileAbort(r), 2);
});

test("readReconcileAbortEpoch returns 0 when never set", async () => {
  assert.equal(await readReconcileAbortEpoch(makeRedis(null)), 0);
});

test("readReconcileAbortEpoch parses the stored counter", async () => {
  assert.equal(await readReconcileAbortEpoch(makeRedis("5")), 5);
});

test("readReconcileAbortEpoch returns 0 for an unparseable value", async () => {
  assert.equal(await readReconcileAbortEpoch(makeRedis("garbage")), 0);
});

test("signal then read reflects the bump (cross-process contract)", async () => {
  const r = makeRedis();
  await signalReconcileAbort(r);
  assert.equal(await readReconcileAbortEpoch(r), 1);
});

test("uses the documented Redis key", async () => {
  let usedKey = "";
  await signalReconcileAbort({ incr: async (k: string) => { usedKey = k; return 1; } });
  assert.equal(usedKey, RECONCILE_ABORT_EPOCH_KEY);
});
