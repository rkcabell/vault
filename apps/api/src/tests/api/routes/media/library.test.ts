import test from "node:test";
import assert from "node:assert/strict";
import { mediaLibraryRoutes } from "@/routes/media/library.js";
import { buildRouteApp, AUTH } from "../helpers/buildRouteApp.js";

const build = (services = {}) => buildRouteApp(mediaLibraryRoutes, { services });

// ── GET / — list media ─────────────────────────────────────────────────────────

test("GET /: returns media list from queryService", async () => {
  const app = await build({
    queryService: {
      listMedia: async () => ({ items: [{ id: "m-1", title: "photo.jpg" }], nextCursor: null }),
    },
  });

  const res = await app.inject({ method: "GET", url: "/", headers: AUTH });

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().items.length, 1);
  assert.equal(res.json().items[0].id, "m-1");
});

test("GET /: ?tag and ?tags together returns 400", async () => {
  const app = await build();
  const res = await app.inject({ method: "GET", url: "/?tag=foo&tags=bar", headers: AUTH });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().message, /either.*tag.*or.*tags/i);
});

test("GET /: empty ?tags= value returns 400", async () => {
  const app = await build();
  const res = await app.inject({ method: "GET", url: "/?tags=", headers: AUTH });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().message, /at least one tag/i);
});

test("GET /: unauthenticated returns 401", async () => {
  const app = await build();
  const res = await app.inject({ method: "GET", url: "/" });
  assert.equal(res.statusCode, 401);
});

// The delete side of this pair lives in deleteJobs.test.ts — the two schemas
// must agree, and neither is `.strict()`.
test("GET /: forwards missing=only to the query service", async () => {
  let seen: Record<string, unknown> | null = null;
  const app = await build({
    queryService: {
      listMedia: async (_u: string, opts: unknown) => { seen = opts as Record<string, unknown>; return { items: [], nextCursor: null }; },
    },
  });
  const res = await app.inject({ method: "GET", url: "/?missing=only", headers: AUTH });

  assert.equal(res.statusCode, 200);
  assert.equal(seen!.missing, "only");
});

test("GET /: rejects a missing value other than 'only'", async () => {
  const app = await build();
  const res = await app.inject({ method: "GET", url: "/?missing=all", headers: AUTH });
  assert.equal(res.statusCode, 500); // ZodError — not silently ignored
});

// ── aggregates ─────────────────────────────────────────────────────────────────

test("GET /stats: returns the query service's aggregate", async () => {
  const app = await build({ queryService: { getStats: async () => ({ count: 7, totalBytes: 1024, byType: [] }) } });
  const res = await app.inject({ method: "GET", url: "/stats", headers: AUTH });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().count, 7);
});

test("GET /storage: reshapes the treemap payload to { items, totalFiles, totalBytes }", async () => {
  const app = await build({
    queryService: {
      listAllSizes: async () => ({ tiles: [{ id: "m-1", bytes: 10 }], totalFiles: 1, totalBytes: 10 }),
    },
  });
  const res = await app.inject({ method: "GET", url: "/storage", headers: AUTH });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { items: [{ id: "m-1", bytes: 10 }], totalFiles: 1, totalBytes: 10 });
});

test("GET /storage: forwards top/sample tuning params", async () => {
  let seen: { topN?: number; sampleN?: number } | null = null;
  const app = await build({
    queryService: {
      listAllSizes: async (_u: string, opts: { topN?: number; sampleN?: number }) => {
        seen = opts;
        return { tiles: [], totalFiles: 0, totalBytes: 0 };
      },
    },
  });
  const res = await app.inject({ method: "GET", url: "/storage?top=50&sample=10", headers: AUTH });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(seen, { topN: 50, sampleN: 10 });
});

test("GET /storage/categories: returns the per-type breakdown", async () => {
  const app = await build({
    queryService: { getCategoryBreakdown: async () => [{ category: "pdf", count: 2, bytes: 99 }] },
  });
  const res = await app.inject({ method: "GET", url: "/storage/categories", headers: AUTH });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json()[0].category, "pdf");
});

test("GET /text/scanned/count: wraps the backlog size in { count }", async () => {
  const app = await build({ queryService: { countScannedAwaitingOcr: async () => 42 } });
  const res = await app.inject({ method: "GET", url: "/text/scanned/count", headers: AUTH });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { count: 42 });
});

test("GET /stats: unauthenticated returns 401", async () => {
  const app = await build();
  const res = await app.inject({ method: "GET", url: "/stats" });
  assert.equal(res.statusCode, 401);
});
