import test from "node:test";
import assert from "node:assert/strict";
import { sidecarRoutes } from "@/routes/sidecars.js";
import { buildRouteApp, AUTH } from "./helpers/buildRouteApp.js";

const service = {
  getStatus: async () => ({ enabled: true, mode: "interval", snapshot: { entries: 3 }, restore: null }),
  exportSnapshot: async () => ({ entries: 3 }),
  startRestore: async () => ({ started: true }),
};

const build = (decorate: Record<string, unknown> = {}) =>
  buildRouteApp(sidecarRoutes, { decorate: { sidecarService: service, ...decorate } });

const refuse = {
  userRateLimit: () => async (_req: unknown, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) =>
    reply.code(429).send({ error: "rate_limited" }),
};

// Export reads the whole library and restore rewrites it, so both carry the
// tightest bucket in rateLimits.ts. Asserts the guard is in the chain, not the
// bucket's size.
test("POST /export and /restore refuse when the limiter does", async () => {
  const app = await build(refuse);

  for (const url of ["/export", "/restore"]) {
    const res = await app.inject({ method: "POST", url, headers: AUTH });
    assert.equal(res.statusCode, 429, url);
  }
});

// GET / is the one route that must answer with the service absent — the settings
// card cannot otherwise tell "snapshots are on" from "the server will never
// write one" — so it is deliberately not behind the bucket.
test("GET /: unlimited, and answers with the service disabled", async () => {
  const app = await buildRouteApp(sidecarRoutes, {
    preferences: { sidecarMode: "off" },
    decorate: refuse,
  });
  const res = await app.inject({ method: "GET", url: "/", headers: AUTH });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { enabled: false, mode: "off", snapshot: null, restore: null });
});

test("POST /export: unauthenticated returns 401", async () => {
  const app = await build();
  const res = await app.inject({ method: "POST", url: "/export" });
  assert.equal(res.statusCode, 401);
});
