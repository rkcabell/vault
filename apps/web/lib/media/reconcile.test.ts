import test from "node:test";
import assert from "node:assert/strict";
import { getReconcileState } from "./reconcile.js";

/** Swap the global fetch apiFetch() calls for the duration of one run, then restore it. */
async function withFetch<T> (impl: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

test("getReconcileState returns null on a non-ok response", async () => {
  const state = await withFetch(
    (async () => ({ ok: false, status: 500, json: async () => ({}) })) as unknown as typeof fetch,
    () => getReconcileState(),
  );
  assert.equal(state, null);
});

test("getReconcileState returns null when the fetch throws", async () => {
  const state = await withFetch(
    (async () => { throw new Error("network down"); }) as unknown as typeof fetch,
    () => getReconcileState(),
  );
  assert.equal(state, null);
});

test("getReconcileState returns the parsed body on a successful response", async () => {
  const body = { active: null, last: null };
  const state = await withFetch(
    (async () => ({ ok: true, status: 200, json: async () => body })) as unknown as typeof fetch,
    () => getReconcileState(),
  );
  assert.deepEqual(state, body);
});
