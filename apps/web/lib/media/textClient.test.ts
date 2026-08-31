import test from "node:test";
import assert from "node:assert/strict";
import { rerunMediaTextExtraction } from "./textClient.js";

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

const respond = (status: number, body: unknown) =>
  (async () => ({ ok: status < 400, status, json: async () => body })) as unknown as typeof fetch;

test("rerunMediaTextExtraction returns the parsed body when the run was queued", async () => {
  const result = await withFetch(
    respond(200, { ok: true, queued: true }),
    () => rerunMediaTextExtraction("m1"),
  );
  assert.deepEqual(result, { ok: true, queued: true });
});

// The server answers 200 with queued:false when it refused the transition — the
// row is UNSUPPORTED and nothing was enqueued. Reading this is what stops the
// panel flipping to "Extracting" over work that never started.
test("rerunMediaTextExtraction surfaces a refusal rather than throwing", async () => {
  const result = await withFetch(
    respond(200, { ok: true, queued: false }),
    () => rerunMediaTextExtraction("m1"),
  );
  assert.deepEqual(result, { ok: true, queued: false });
});

test("rerunMediaTextExtraction throws the server's message on a failure", async () => {
  await withFetch(respond(500, { message: "boom" }), async () => {
    await assert.rejects(() => rerunMediaTextExtraction("m1"), /boom/);
  });
});
