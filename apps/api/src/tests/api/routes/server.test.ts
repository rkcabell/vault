// GET /workers tests require Redis at redis://localhost:6379.
// Run `pnpm run localdocker` before executing this file.
import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import sensible from "@fastify/sensible";
import { serverRoutes } from "@/routes/server.js";

process.env.REDIS_URL   = "redis://localhost:6379";
process.env.OCR_QUEUE   = "ocr_queue";
process.env.THUMB_QUEUE = "thumb_queue";

// ── mock helpers ──────────────────────────────────────────────────────────────

interface BuildOpts {
  nodeEnv?: string;
}

async function buildApp(opts: BuildOpts = {}) {
  const app = Fastify({ logger: false });
  await app.register(sensible);

  (app as any).decorate("jwt", {
    verifyAccess:  () => ({ sub: "user-1" }),
    signAccess:    () => "",
    signRefresh:   () => "",
    verifyRefresh: () => ({ sub: "user-1" }),
  });

  (app as any).decorate("config", {
    NODE_ENV:    opts.nodeEnv ?? "development",
    PORT:        8000,
    CORS_ORIGIN: "http://localhost:3000",
    REDIS_URL:   "redis://localhost:6379",
  });

  await app.register(serverRoutes);
  return app;
}

const AUTH = { authorization: "Bearer test-token" };

// ── GET /status ───────────────────────────────────────────────────────────────

test("GET /status: returns runtime config and uptime", async () => {
  const app = await buildApp();
  const res = await app.inject({ method: "GET", url: "/status", headers: AUTH });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.env, "development");
  assert.equal(body.apiPort, 8000);
  assert.equal(body.corsOrigin, "http://localhost:3000");
  assert.equal(typeof body.uptimeSeconds, "number");
});

test("GET /status: unauthenticated returns 401", async () => {
  const app = await buildApp();
  const res = await app.inject({ method: "GET", url: "/status" });
  assert.equal(res.statusCode, 401);
});

// ── GET /workers ──────────────────────────────────────────────────────────────

test("GET /workers: returns worker activity shape (requires Redis)", async () => {
  const app = await buildApp();
  const res = await app.inject({ method: "GET", url: "/workers", headers: AUTH });
  assert.equal(res.statusCode, 200);
  const body = res.json() as {
    ocr:   { active: boolean; count: number };
    thumb: { active: boolean; count: number };
  };
  // Verify response shape — actual active/count values depend on running workers
  assert.equal(typeof body.ocr.active, "boolean");
  assert.equal(typeof body.ocr.count, "number");
  assert.equal(typeof body.thumb.active, "boolean");
  assert.equal(typeof body.thumb.count, "number");
  assert.ok(body.ocr.count >= 0);
  assert.ok(body.thumb.count >= 0);
});

test("GET /workers: unauthenticated returns 401", async () => {
  const app = await buildApp();
  const res = await app.inject({ method: "GET", url: "/workers" });
  assert.equal(res.statusCode, 401);
});
