import test from "node:test";
import assert from "node:assert/strict";
import {
  signalIndexAbort,
  readIndexAbortEpoch,
  INDEX_ABORT_EPOCH_KEY,
} from "@/lib/media/indexAbort.js";

/** Tiny in-memory stand-in for the bits of ioredis we use. */
function makeRedis (initial: string | null = null) {
  let value = initial;
  return {
    incr: async () => { const n = (value ? parseInt(value, 10) : 0) + 1; value = String(n); return n; },
    get: async () => value,
  };
}

test("signalIndexAbort increments and returns the new epoch", async () => {
  const r = makeRedis();
  assert.equal(await signalIndexAbort(r), 1);
  assert.equal(await signalIndexAbort(r), 2);
});

test("readIndexAbortEpoch returns 0 when never set", async () => {
  assert.equal(await readIndexAbortEpoch(makeRedis(null)), 0);
});

test("readIndexAbortEpoch parses the stored counter", async () => {
  assert.equal(await readIndexAbortEpoch(makeRedis("5")), 5);
});

test("readIndexAbortEpoch returns 0 for an unparseable value", async () => {
  assert.equal(await readIndexAbortEpoch(makeRedis("garbage")), 0);
});

test("signal then read reflects the bump (cross-process contract)", async () => {
  const r = makeRedis();
  await signalIndexAbort(r);
  assert.equal(await readIndexAbortEpoch(r), 1);
});

test("uses the documented Redis key", async () => {
  let usedKey = "";
  await signalIndexAbort({ incr: async (k: string) => { usedKey = k; return 1; } });
  assert.equal(usedKey, INDEX_ABORT_EPOCH_KEY);
});
