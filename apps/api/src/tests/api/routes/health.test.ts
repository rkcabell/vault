import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import sensible from "@fastify/sensible";
import { healthRoutes } from "@/routes/health.js";

// ── mock helpers ──────────────────────────────────────────────────────────────

interface BuildOpts {
  dbQueryRaw?: (..._args: unknown[]) => Promise<unknown>;
  redisPing?:  () => Promise<string>;
  s3Send?:     (_cmd: unknown) => Promise<unknown>;
}

async function buildApp(opts: BuildOpts = {}) {
  const app = Fastify({ logger: false });
  await app.register(sensible);

  (app as any).decorate("config", { S3_BUCKET: "vault-media" });
  (app as any).decorate("prisma", {
    $queryRaw: opts.dbQueryRaw ?? (() => Promise.resolve([{ "?column?": 1 }])),
  });
  (app as any).decorate("redis", {
    ping: opts.redisPing ?? (() => Promise.resolve("PONG")),
  });
  (app as any).decorate("s3", {
    send: opts.s3Send ?? (() => Promise.resolve({})),
  });

  await app.register(healthRoutes);
  return app;
}

// ── GET /healthz ──────────────────────────────────────────────────────────────

test("GET /healthz: returns 200 ok", async () => {
  const app = await buildApp();
  const res = await app.inject({ method: "GET", url: "/healthz" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true });
});

// ── GET /readyz ───────────────────────────────────────────────────────────────

test("GET /readyz: returns 200 and all-healthy services when all checks pass", async () => {
  const app = await buildApp();
  const res = await app.inject({ method: "GET", url: "/readyz" });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ready, true);
  assert.deepEqual(body.services, { db: "healthy", redis: "healthy", s3: "healthy" });
});

test("GET /readyz: returns 503 with db degraded when db check fails", async () => {
  const app = await buildApp({
    dbQueryRaw: () => Promise.reject(new Error("connection refused")),
  });
  const res = await app.inject({ method: "GET", url: "/readyz" });
  assert.equal(res.statusCode, 503);
  const body = res.json();
  assert.equal(body.ready, false);
  assert.equal(body.services.db, "degraded");
  assert.equal(body.services.redis, "healthy");
  assert.equal(body.services.s3, "healthy");
});

test("GET /readyz: returns 503 with redis degraded when redis check fails", async () => {
  const app = await buildApp({
    redisPing: () => Promise.reject(new Error("timeout")),
  });
  const res = await app.inject({ method: "GET", url: "/readyz" });
  assert.equal(res.statusCode, 503);
  const body = res.json();
  assert.equal(body.ready, false);
  assert.equal(body.services.db, "healthy");
  assert.equal(body.services.redis, "degraded");
  assert.equal(body.services.s3, "healthy");
});

test("GET /readyz: returns 503 with s3 degraded when s3 check fails", async () => {
  const app = await buildApp({
    s3Send: () => Promise.reject(new Error("NoSuchBucket")),
  });
  const res = await app.inject({ method: "GET", url: "/readyz" });
  assert.equal(res.statusCode, 503);
  const body = res.json();
  assert.equal(body.ready, false);
  assert.equal(body.services.db, "healthy");
  assert.equal(body.services.redis, "healthy");
  assert.equal(body.services.s3, "degraded");
});

test("GET /readyz: returns 503 when all checks fail", async () => {
  const app = await buildApp({
    dbQueryRaw: () => Promise.reject(new Error("down")),
    redisPing:  () => Promise.reject(new Error("down")),
    s3Send:     () => Promise.reject(new Error("down")),
  });
  const res = await app.inject({ method: "GET", url: "/readyz" });
  assert.equal(res.statusCode, 503);
  const body = res.json();
  assert.equal(body.ready, false);
  assert.deepEqual(body.services, { db: "degraded", redis: "degraded", s3: "degraded" });
});

test("GET /readyz: healthy services remain healthy when others degrade", async () => {
  const app = await buildApp({
    redisPing: () => Promise.reject(new Error("down")),
    s3Send:    () => Promise.reject(new Error("down")),
  });
  const res = await app.inject({ method: "GET", url: "/readyz" });
  assert.equal(res.statusCode, 503);
  const body = res.json();
  assert.equal(body.services.db, "healthy");
  assert.equal(body.services.redis, "degraded");
  assert.equal(body.services.s3, "degraded");
});
