import test from "node:test";
import assert from "node:assert/strict";
import { mediaDerivativesRoutes } from "@/routes/media/derivatives.js";
import { buildRouteApp, AUTH, JSON_HEADERS, ID } from "../helpers/buildRouteApp.js";

const build = (services = {}) => buildRouteApp(mediaDerivativesRoutes, { services });

/** The allow-list snapshot every enqueue route in this file has to forward. */
const withRoots = (services = {}, roots = ["C:\\nas"]) =>
  buildRouteApp(mediaDerivativesRoutes, { services, preferences: { indexAllowedRoots: roots } });

// ── GET /:id/text ──────────────────────────────────────────────────────────────

test("GET /:id/text: returns text chunk with default offset/limit", async () => {
  const app = await build({
    readService: { getTextChunk: async () => ({ text: "hello world", offset: 0, total: 11 }) },
  });
  const res = await app.inject({ method: "GET", url: `/${ID}/text`, headers: AUTH });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().text, "hello world");
});

test("GET /:id/text: not found returns 404", async () => {
  const app = await build({ readService: { getTextChunk: async () => null } });
  const res = await app.inject({ method: "GET", url: `/${ID}/text`, headers: AUTH });
  assert.equal(res.statusCode, 404);
});

test("GET /:id/text: unauthenticated returns 401", async () => {
  const app = await build();
  const res = await app.inject({ method: "GET", url: `/${ID}/text` });
  assert.equal(res.statusCode, 401);
});

// ── POST /:id/text — enqueue text extraction ───────────────────────────────────

test("POST /:id/text: enqueues extraction and returns result", async () => {
  const app = await build({
    actionsService: { enqueueTextExtraction: async () => ({ jobId: "j-1", status: "PENDING" }) },
  });
  const res = await app.inject({
    method: "POST", url: `/${ID}/text`,
    headers: JSON_HEADERS,
    payload: JSON.stringify({}),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().jobId, "j-1");
});

test("POST /:id/text: forwards the allow-list snapshot the worker re-validates against", async () => {
  let roots: string[] | undefined;
  const app = await withRoots({
    actionsService: {
      enqueueTextExtraction: async (_u: string, _id: string, _o: unknown, r: string[]) => { roots = r; return { ok: true }; },
    },
  });
  const res = await app.inject({
    method: "POST", url: `/${ID}/text`,
    headers: JSON_HEADERS,
    payload: JSON.stringify({}),
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(roots, ["C:\\nas"]);
});

test("POST /:id/text: not found returns 404", async () => {
  const app = await build({ actionsService: { enqueueTextExtraction: async () => null } });
  const res = await app.inject({
    method: "POST", url: `/${ID}/text`,
    headers: JSON_HEADERS,
    payload: JSON.stringify({}),
  });
  assert.equal(res.statusCode, 404);
});

test("POST /:id/text: unauthenticated returns 401", async () => {
  const app = await build();
  const res = await app.inject({ method: "POST", url: `/${ID}/text` });
  assert.equal(res.statusCode, 401);
});

// ── POST /:id/text/cancel ──────────────────────────────────────────────────────

test("POST /:id/text/cancel: cancels extraction and returns result", async () => {
  const app = await build({ actionsService: { cancelTextExtraction: async () => ({ ok: true }) } });
  const res = await app.inject({ method: "POST", url: `/${ID}/text/cancel`, headers: AUTH });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().ok, true);
});

test("POST /:id/text/cancel: not found returns 404", async () => {
  const app = await build({ actionsService: { cancelTextExtraction: async () => null } });
  const res = await app.inject({ method: "POST", url: `/${ID}/text/cancel`, headers: AUTH });
  assert.equal(res.statusCode, 404);
});

test("POST /:id/text/cancel: unauthenticated returns 401", async () => {
  const app = await build();
  const res = await app.inject({ method: "POST", url: `/${ID}/text/cancel` });
  assert.equal(res.statusCode, 401);
});

// ── POST /:id/thumbnail/regenerate ────────────────────────────────────────────

test("POST /:id/thumbnail/regenerate: returns result", async () => {
  const app = await build({ actionsService: { regenerateThumbnail: async () => ({ jobId: "t-1" }) } });
  const res = await app.inject({ method: "POST", url: `/${ID}/thumbnail/regenerate`, headers: AUTH });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().jobId, "t-1");
});

test("POST /:id/thumbnail/regenerate: not found returns 404", async () => {
  const app = await build({ actionsService: { regenerateThumbnail: async () => null } });
  const res = await app.inject({ method: "POST", url: `/${ID}/thumbnail/regenerate`, headers: AUTH });
  assert.equal(res.statusCode, 404);
});

test("POST /:id/thumbnail/regenerate: unauthenticated returns 401", async () => {
  const app = await build();
  const res = await app.inject({ method: "POST", url: `/${ID}/thumbnail/regenerate` });
  assert.equal(res.statusCode, 401);
});

// ── POST /batch/thumbnail ──────────────────────────────────────────────────────

test("POST /batch/thumbnail: forwards ids + allowedRoots snapshot and returns summary", async () => {
  let captured: { ids: string[]; roots?: string[] } | undefined;
  const app = await withRoots({
    actionsService: {
      regenerateThumbnailsBatch: async (_u: string, ids: string[], roots?: string[]) => { captured = { ids, roots }; return { queued: ids.length, missing: 0 }; },
    },
  });

  const res = await app.inject({
    method: "POST", url: "/batch/thumbnail",
    headers: JSON_HEADERS,
    payload: JSON.stringify({ ids: [ID, "m-2"] }),
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { queued: 2, missing: 0 });
  assert.deepEqual(captured?.ids, [ID, "m-2"]);
  assert.deepEqual(captured?.roots, ["C:\\nas"]);
});

test("POST /batch/thumbnail: empty ids returns 400", async () => {
  const app = await build();
  const res = await app.inject({
    method: "POST", url: "/batch/thumbnail",
    headers: JSON_HEADERS,
    payload: JSON.stringify({ ids: [] }),
  });
  assert.equal(res.statusCode, 400);
});

test("POST /batch/thumbnail: unauthenticated returns 401", async () => {
  const app = await build();
  const res = await app.inject({
    method: "POST", url: "/batch/thumbnail",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ ids: [ID] }),
  });
  assert.equal(res.statusCode, 401);
});

// ── POST /batch/text ───────────────────────────────────────────────────────────

test("POST /batch/text: forwards ids + allowedRoots snapshot and returns summary", async () => {
  let captured: { ids: string[]; roots?: string[] } | undefined;
  const app = await withRoots({
    actionsService: {
      enqueueTextExtractionBatch: async (_u: string, ids: string[], roots?: string[]) => { captured = { ids, roots }; return { queued: ids.length, missing: 0 }; },
    },
  });

  const res = await app.inject({
    method: "POST", url: "/batch/text",
    headers: JSON_HEADERS,
    payload: JSON.stringify({ ids: [ID] }),
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { queued: 1, missing: 0 });
  assert.deepEqual(captured?.ids, [ID]);
  assert.deepEqual(captured?.roots, ["C:\\nas"]);
});

test("POST /batch/text: empty ids returns 400", async () => {
  const app = await build();
  const res = await app.inject({
    method: "POST", url: "/batch/text",
    headers: JSON_HEADERS,
    payload: JSON.stringify({ ids: [] }),
  });
  assert.equal(res.statusCode, 400);
});

test("POST /batch/text: unauthenticated returns 401", async () => {
  const app = await build();
  const res = await app.inject({
    method: "POST", url: "/batch/text",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ ids: [ID] }),
  });
  assert.equal(res.statusCode, 401);
});

// ── POST /batch/text/scanned ───────────────────────────────────────────────────

test("POST /batch/text/scanned: an empty body drains at the service's own default", async () => {
  let seenLimit: number | undefined = -1;
  const app = await build({
    actionsService: {
      extractAllScannedText: async (_u: string, _r: string[], limit?: number) => { seenLimit = limit; return { queued: 3, remaining: 0 }; },
    },
  });
  const res = await app.inject({ method: "POST", url: "/batch/text/scanned", headers: AUTH });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { queued: 3, remaining: 0 });
  assert.equal(seenLimit, undefined);
});

test("POST /batch/text/scanned: honours an explicit limit", async () => {
  let seenLimit: number | undefined;
  const app = await build({
    actionsService: {
      extractAllScannedText: async (_u: string, _r: string[], limit?: number) => { seenLimit = limit; return { queued: 10, remaining: 5 }; },
    },
  });
  const res = await app.inject({
    method: "POST", url: "/batch/text/scanned",
    headers: JSON_HEADERS,
    payload: JSON.stringify({ limit: 10 }),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(seenLimit, 10);
});

test("POST /batch/text/scanned: a non-positive limit returns 400", async () => {
  const app = await build();
  const res = await app.inject({
    method: "POST", url: "/batch/text/scanned",
    headers: JSON_HEADERS,
    payload: JSON.stringify({ limit: 0 }),
  });
  assert.equal(res.statusCode, 400);
});

// ── POST /batch/thumbnail/prioritize ───────────────────────────────────────────

test("POST /batch/thumbnail/prioritize: hands the visible ids to the feeder", async () => {
  let promoted: string[] | null = null;
  const app = await buildRouteApp(mediaDerivativesRoutes, {
    decorate: {
      derivativeFeeder: {
        promoteThumbnails: async (_u: string, ids: string[]) => { promoted = ids; return { queued: 2, reordered: 1 }; },
      },
    },
  });

  const res = await app.inject({
    method: "POST", url: "/batch/thumbnail/prioritize",
    headers: JSON_HEADERS,
    payload: JSON.stringify({ ids: [ID, "m-2"] }),
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { queued: 2, reordered: 1 });
  assert.deepEqual(promoted, [ID, "m-2"]);
});

// A missing feeder is DERIVATIVE_FEED_ENABLED=false — the user having switched
// derivatives off, not an error to raise at them mid-scroll.
test("POST /batch/thumbnail/prioritize: no feeder answers 200 with zeroes, not an error", async () => {
  const app = await build();
  const res = await app.inject({
    method: "POST", url: "/batch/thumbnail/prioritize",
    headers: JSON_HEADERS,
    payload: JSON.stringify({ ids: [ID] }),
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { queued: 0, reordered: 0 });
});

// ── POST /batch/text/prioritize ────────────────────────────────────────────────

test("POST /batch/text/prioritize: hands the ids to the feeder's tier-1 promotion", async () => {
  let promoted: string[] | null = null;
  const app = await buildRouteApp(mediaDerivativesRoutes, {
    decorate: {
      derivativeFeeder: {
        promoteText: async (_u: string, ids: string[]) => { promoted = ids; return { queued: 1, reordered: 0 }; },
      },
    },
  });

  const res = await app.inject({
    method: "POST", url: "/batch/text/prioritize",
    headers: JSON_HEADERS,
    payload: JSON.stringify({ ids: [ID, "m-2"] }),
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { queued: 1, reordered: 0 });
  assert.deepEqual(promoted, [ID, "m-2"]);
});

test("POST /batch/text/prioritize: no feeder answers 200 with zeroes, not an error", async () => {
  const app = await build();
  const res = await app.inject({
    method: "POST", url: "/batch/text/prioritize",
    headers: JSON_HEADERS,
    payload: JSON.stringify({ ids: [ID] }),
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { queued: 0, reordered: 0 });
});

// ── rate limiting ──────────────────────────────────────────────────────────────

// Every batch route re-queues or promotes across the library, so each carries a
// bucket. This asserts the guard is in the chain, not the bucket's size — the
// two prioritize routes deliberately sit in a much looser one, since the grid
// posts to them on every scroll settle.
test("every batch route refuses when its limiter does", async () => {
  const app = await buildRouteApp(mediaDerivativesRoutes, {
    decorate: {
      userRateLimit: () => async (_req: unknown, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) =>
        reply.code(429).send({ error: "rate_limited" }),
    },
  });

  for (const url of [
    "/batch/thumbnail",
    "/batch/text",
    "/batch/text/scanned",
    "/batch/thumbnail/prioritize",
    "/batch/text/prioritize",
  ]) {
    const res = await app.inject({
      method: "POST", url,
      headers: JSON_HEADERS,
      payload: JSON.stringify({ ids: [ID] }),
    });
    assert.equal(res.statusCode, 429, url);
  }
});

// ── GET /:id/text/queue-position ───────────────────────────────────────────────

test("GET /:id/text/queue-position: returns where the row sits in the tier-1 backlog", async () => {
  const app = await build({ readService: { getTextQueuePosition: async () => ({ position: 7, total: 42 }) } });
  const res = await app.inject({ method: "GET", url: `/${ID}/text/queue-position`, headers: AUTH });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { position: 7, total: 42 });
});

// Null covers both "not the caller's" and "already dispatched" — the panel shows
// "extracting" rather than a position once a job exists.
test("GET /:id/text/queue-position: a row that isn't waiting returns 404", async () => {
  const app = await build({ readService: { getTextQueuePosition: async () => null } });
  const res = await app.inject({ method: "GET", url: `/${ID}/text/queue-position`, headers: AUTH });
  assert.equal(res.statusCode, 404);
});

test("GET /:id/text/queue-position: unauthenticated returns 401", async () => {
  const app = await build();
  const res = await app.inject({ method: "GET", url: `/${ID}/text/queue-position` });
  assert.equal(res.statusCode, 401);
});
