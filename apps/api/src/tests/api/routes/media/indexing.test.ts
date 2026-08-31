import test from "node:test";
import assert from "node:assert/strict";
import { mediaIndexingRoutes } from "@/routes/media/indexing.js";
import { buildRouteApp, AUTH, JSON_HEADERS } from "../helpers/buildRouteApp.js";

const build = (services = {}, preferences = {}) =>
  buildRouteApp(mediaIndexingRoutes, { services, preferences });

// ── GET /index/roots ───────────────────────────────────────────────────────────

test("GET /index/roots: no configured roots reports indexing disabled", async () => {
  const app = await build();
  const res = await app.inject({ method: "GET", url: "/index/roots", headers: AUTH });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { enabled: false, roots: [] });
});

test("GET /index/roots: configured roots report enabled", async () => {
  const app = await build({}, { indexAllowedRoots: ["E:\\photos"] });
  const res = await app.inject({ method: "GET", url: "/index/roots", headers: AUTH });
  assert.deepEqual(res.json(), { enabled: true, roots: ["E:\\photos"] });
});

// ── POST /index ────────────────────────────────────────────────────────────────

test("POST /index: forwards the path plus the walk preferences and returns the job id", async () => {
  let seen: { path: string; recursive: boolean; ignoreHidden: boolean } | null = null;
  let seenRoots: string[] | null = null;
  const app = await build(
    {
      indexService: {
        startIndex: async (_u: string, opts: typeof seen, roots: string[]) => {
          seen = opts; seenRoots = roots; return { ok: true, jobId: "idx-1" };
        },
      },
    },
    { indexAllowedRoots: ["E:\\photos"], ignoreHiddenFiles: false },
  );

  const res = await app.inject({
    method: "POST", url: "/index",
    headers: JSON_HEADERS,
    payload: JSON.stringify({ path: "E:\\photos\\2026" }),
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { jobId: "idx-1" });
  assert.equal(seen!.path, "E:\\photos\\2026");
  assert.equal(seen!.recursive, true, "recursive defaults on");
  assert.equal(seen!.ignoreHidden, false, "the preference is honoured");
  assert.deepEqual(seenRoots, ["E:\\photos"]);
});

test("POST /index: disabled indexing returns 400", async () => {
  const app = await build({ indexService: { startIndex: async () => ({ ok: false, reason: "disabled" }) } });
  const res = await app.inject({
    method: "POST", url: "/index",
    headers: JSON_HEADERS,
    payload: JSON.stringify({ path: "E:\\photos" }),
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().message, /In-place indexing is disabled/);
});

test("POST /index: a path outside the allow-list returns 403", async () => {
  const app = await build({ indexService: { startIndex: async () => ({ ok: false, reason: "not_allowed" }) } });
  const res = await app.inject({
    method: "POST", url: "/index",
    headers: JSON_HEADERS,
    payload: JSON.stringify({ path: "E:\\elsewhere" }),
  });
  assert.equal(res.statusCode, 403);
});

test("POST /index: a missing folder returns 404 and a file returns 400", async () => {
  const missing = await build({ indexService: { startIndex: async () => ({ ok: false, reason: "not_found" }) } });
  const notDir = await build({ indexService: { startIndex: async () => ({ ok: false, reason: "not_dir" }) } });
  const payload = JSON.stringify({ path: "E:\\photos" });

  assert.equal((await missing.inject({ method: "POST", url: "/index", headers: JSON_HEADERS, payload })).statusCode, 404);
  assert.equal((await notDir.inject({ method: "POST", url: "/index", headers: JSON_HEADERS, payload })).statusCode, 400);
});

test("POST /index: a scan already in flight returns 409 naming the way out", async () => {
  const app = await build({ indexService: { startIndex: async () => ({ ok: false, reason: "already_running" }) } });
  const res = await app.inject({
    method: "POST", url: "/index",
    headers: JSON_HEADERS,
    payload: JSON.stringify({ path: "E:\\photos" }),
  });
  assert.equal(res.statusCode, 409);
  assert.match(res.json().message, /Cancel scan/);
});

test("POST /index: a tripped rate limit answers 429 and never reaches the service", async () => {
  let started = false;
  const app = await buildRouteApp(mediaIndexingRoutes, {
    services: { indexService: { startIndex: async () => { started = true; return { ok: true, jobId: "idx-1" }; } } },
    decorate: {
      userRateLimit: () => async (_req: unknown, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) =>
        reply.code(429).send({ error: "rate_limited" }),
    },
  });

  const res = await app.inject({
    method: "POST", url: "/index",
    headers: JSON_HEADERS,
    payload: JSON.stringify({ path: "E:\\photos" }),
  });

  assert.equal(res.statusCode, 429);
  assert.equal(started, false, "the guard has to stop the chain, not just set a status");
});

test("POST /index: unauthenticated returns 401", async () => {
  const app = await build();
  const res = await app.inject({ method: "POST", url: "/index" });
  assert.equal(res.statusCode, 401);
});

// ── scan status ────────────────────────────────────────────────────────────────

test("GET /index/status: returns the walk's progress", async () => {
  const app = await build({ indexService: { getStatus: async () => ({ jobId: "idx-1", scanned: 12 }) } });
  const res = await app.inject({ method: "GET", url: "/index/status?jobId=idx-1", headers: AUTH });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().scanned, 12);
});

test("GET /index/status: an unknown job returns 404", async () => {
  const app = await build({ indexService: { getStatus: async () => null } });
  const res = await app.inject({ method: "GET", url: "/index/status?jobId=nope", headers: AUTH });
  assert.equal(res.statusCode, 404);
});

test("GET /index/active: nothing running answers { status: null }", async () => {
  const app = await build();
  const res = await app.inject({ method: "GET", url: "/index/active", headers: AUTH });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { status: null });
});

// ── reconcile ──────────────────────────────────────────────────────────────────

test("POST /index/reconcile: an omitted path sweeps every root and returns one job id each", async () => {
  let seen: { path?: string; allowedRoots: string[] } | null = null;
  const app = await build(
    {
      reconcileService: {
        startReconcile: async (_u: string, opts: typeof seen) => {
          seen = opts; return { ok: true, jobIds: ["r-1", "r-2"] };
        },
      },
    },
    { indexAllowedRoots: ["E:\\a", "E:\\b"] },
  );

  const res = await app.inject({ method: "POST", url: "/index/reconcile", headers: AUTH });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { jobIds: ["r-1", "r-2"] });
  assert.equal(seen!.path, undefined, "no path key at all, not an explicit undefined");
  assert.deepEqual(seen!.allowedRoots, ["E:\\a", "E:\\b"]);
});

test("POST /index/reconcile: a body path narrows the sweep to one root", async () => {
  let seen: { path?: string } | null = null;
  const app = await build({
    reconcileService: {
      startReconcile: async (_u: string, opts: typeof seen) => { seen = opts; return { ok: true, jobIds: ["r-1"] }; },
    },
  });

  const res = await app.inject({
    method: "POST", url: "/index/reconcile",
    headers: JSON_HEADERS,
    payload: JSON.stringify({ path: "E:\\a" }),
  });

  assert.equal(res.statusCode, 200);
  assert.equal(seen!.path, "E:\\a");
});

test("POST /index/reconcile: a path outside the allow-list returns 403", async () => {
  const app = await build({
    reconcileService: { startReconcile: async () => ({ ok: false, reason: "not_allowed" }) },
  });
  const res = await app.inject({
    method: "POST", url: "/index/reconcile",
    headers: JSON_HEADERS,
    payload: JSON.stringify({ path: "E:\\elsewhere" }),
  });
  assert.equal(res.statusCode, 403);
});

test("GET /index/reconcile/state: returns the running sweep and the last finished one", async () => {
  const app = await build({
    reconcileService: { getState: async () => ({ running: { jobId: "r-1" }, last: { checked: 9 } }) },
  });
  const res = await app.inject({ method: "GET", url: "/index/reconcile/state", headers: AUTH });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().running.jobId, "r-1");
  assert.equal(res.json().last.checked, 9);
});

test("GET /index/reconcile/state: unauthenticated returns 401", async () => {
  const app = await build();
  const res = await app.inject({ method: "GET", url: "/index/reconcile/state" });
  assert.equal(res.statusCode, 401);
});
