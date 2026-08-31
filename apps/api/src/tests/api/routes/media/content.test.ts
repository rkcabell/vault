import test from "node:test";
import assert from "node:assert/strict";
import { mediaContentRoutes } from "@/routes/media/content.js";
import { buildRouteApp, AUTH, JSON_HEADERS, ID } from "../helpers/buildRouteApp.js";

const build = (services = {}) => buildRouteApp(mediaContentRoutes, { services });

// ── POST /bulk-download ────────────────────────────────────────────────────────

// The success path uses reply.hijack() for streaming. Only pre-stream paths
// are testable via app.inject().
test("POST /bulk-download: no items found returns 404", async () => {
  const app = await build({ archiveService: { getBulkDownloadItems: async () => [] } });
  const res = await app.inject({
    method: "POST", url: "/bulk-download",
    headers: JSON_HEADERS,
    payload: JSON.stringify({ ids: [ID] }),
  });
  assert.equal(res.statusCode, 404);
});

test("POST /bulk-download: unauthenticated returns 401", async () => {
  const app = await build();
  const res = await app.inject({
    method: "POST", url: "/bulk-download",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ ids: [ID] }),
  });
  assert.equal(res.statusCode, 401);
});

// Zipping and streaming a selection is one of the few requests that can hold a
// connection open for minutes, so it carries a bucket. Asserts the guard is in
// the chain, not the bucket's size.
test("POST /bulk-download: refuses when the limiter does", async () => {
  const app = await buildRouteApp(mediaContentRoutes, {
    services: { archiveService: { getBulkDownloadItems: async () => [] } },
    decorate: {
      userRateLimit: () => async (_req: unknown, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) =>
        reply.code(429).send({ error: "rate_limited" }),
    },
  });
  const res = await app.inject({
    method: "POST", url: "/bulk-download",
    headers: JSON_HEADERS,
    payload: JSON.stringify({ ids: [ID] }),
  });
  assert.equal(res.statusCode, 429);
});

// ── GET /:id/download ──────────────────────────────────────────────────────────

test("GET /:id/download: returns presigned URL", async () => {
  const app = await build({ actionsService: { getDownloadUrl: async () => "https://s3.test/signed-url" } });
  const res = await app.inject({ method: "GET", url: `/${ID}/download`, headers: AUTH });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /signed-url/);
});

test("GET /:id/download: not found returns 404", async () => {
  const app = await build({ actionsService: { getDownloadUrl: async () => null } });
  const res = await app.inject({ method: "GET", url: `/${ID}/download`, headers: AUTH });
  assert.equal(res.statusCode, 404);
});

test("GET /:id/download: unauthenticated returns 401", async () => {
  const app = await build();
  const res = await app.inject({ method: "GET", url: `/${ID}/download` });
  assert.equal(res.statusCode, 401);
});

// ── GET /:id/source ────────────────────────────────────────────────────────────

test("GET /:id/source: a row with no readable source returns 404", async () => {
  const app = await build({ readService: { getSourceStream: async () => null } });
  const res = await app.inject({ method: "GET", url: `/${ID}/source`, headers: AUTH });
  assert.equal(res.statusCode, 404);
});

test("GET /:id/source: unauthenticated returns 401", async () => {
  const app = await build();
  const res = await app.inject({ method: "GET", url: `/${ID}/source` });
  assert.equal(res.statusCode, 401);
});

// ── GET /:id/thumbnail ────────────────────────────────────────────────────────

test("GET /:id/thumbnail: returns webp content-type when thumbnail exists", async () => {
  const fakeWebp = Buffer.from([0x52, 0x49, 0x46, 0x46]); // "RIFF" — start of a WebP file
  const app = await build({ readService: { getThumbnail: async () => ({ body: fakeWebp, etag: "abc123" }) } });
  const res = await app.inject({ method: "GET", url: `/${ID}/thumbnail`, headers: AUTH });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "image/webp");
});

test("GET /:id/thumbnail: returns fallback webp when thumbnail is absent", async () => {
  const app = await build({ readService: { getThumbnail: async () => null } });
  const res = await app.inject({ method: "GET", url: `/${ID}/thumbnail`, headers: AUTH });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "image/webp");
});

// The one deliberate departure from `paramsSchema.parse` everywhere else: a
// broken <img> in a grid of thousands is worse than a rejected id.
test("GET /:id/thumbnail: invalid UUID returns fallback webp instead of 400", async () => {
  const app = await build();
  const res = await app.inject({ method: "GET", url: "/not-a-uuid/thumbnail", headers: AUTH });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "image/webp");
});

test("GET /:id/thumbnail: unauthenticated returns 401", async () => {
  const app = await build();
  const res = await app.inject({ method: "GET", url: `/${ID}/thumbnail` });
  assert.equal(res.statusCode, 401);
});
