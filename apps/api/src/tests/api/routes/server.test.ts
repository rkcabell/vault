// GET /workers tests require Redis at redis://localhost:6379.
// Run `pnpm run localdocker` before executing this file.
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import sensible from "@fastify/sensible";
import fs from "node:fs";
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

const AUTH         = { authorization: "Bearer test-token" };
const JSON_HEADERS = { ...AUTH, "content-type": "application/json" };

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

// ── POST /shutdown ────────────────────────────────────────────────────────────

test("POST /shutdown: returns 202 and sends SIGTERM after delay", async () => {
  const app = await buildApp();
  const killSpy = mock.method(process, "kill", () => {});
  try {
    const res = await app.inject({ method: "POST", url: "/shutdown", headers: AUTH });
    assert.equal(res.statusCode, 202);
    assert.deepEqual(res.json(), { ok: true });

    await new Promise<void>(r => setTimeout(r, 300));
    assert.equal(killSpy.mock.callCount(), 1);
    const [pid, sig] = killSpy.mock.calls[0].arguments as [number, string];
    assert.equal(pid, process.pid);
    assert.equal(sig, "SIGTERM");
  } finally {
    killSpy.mock.restore();
  }
});

test("POST /shutdown: unauthenticated returns 401 and does not send SIGTERM", async () => {
  const app = await buildApp();
  const killSpy = mock.method(process, "kill", () => {});
  try {
    const res = await app.inject({ method: "POST", url: "/shutdown" });
    assert.equal(res.statusCode, 401);

    await new Promise<void>(r => setTimeout(r, 300));
    assert.equal(killSpy.mock.callCount(), 0);
  } finally {
    killSpy.mock.restore();
  }
});

// ── POST /restart ─────────────────────────────────────────────────────────────

test("POST /restart: returns 202 and sends SIGTERM after delay", async () => {
  const app = await buildApp();
  const killSpy = mock.method(process, "kill", () => {});
  try {
    const res = await app.inject({ method: "POST", url: "/restart", headers: AUTH });
    assert.equal(res.statusCode, 202);
    assert.deepEqual(res.json(), { ok: true });

    await new Promise<void>(r => setTimeout(r, 300));
    assert.equal(killSpy.mock.callCount(), 1);
  } finally {
    killSpy.mock.restore();
  }
});

test("POST /restart: unauthenticated returns 401", async () => {
  const app = await buildApp();
  const res = await app.inject({ method: "POST", url: "/restart" });
  assert.equal(res.statusCode, 401);
});

// ── PATCH /config ─────────────────────────────────────────────────────────────

test("PATCH /config: writes new port and restarts in dev mode", async () => {
  const app = await buildApp();
  const existsSpy = mock.method(fs, "existsSync",   () => true);
  const readSpy   = mock.method(fs, "readFileSync",  () => "PORT=8000\n");
  const writeSpy  = mock.method(fs, "writeFileSync", () => {});
  const killSpy   = mock.method(process, "kill",     () => {});
  try {
    const res = await app.inject({
      method:  "PATCH",
      url:     "/config",
      headers: JSON_HEADERS,
      payload: JSON.stringify({ apiPort: 9000 }),
    });
    assert.equal(res.statusCode, 202);
    assert.deepEqual(res.json(), { ok: true });

    assert.equal(writeSpy.mock.callCount(), 1);
    const written = writeSpy.mock.calls[0].arguments[1] as string;
    assert.ok(written.includes("PORT=9000"), "written content should contain PORT=9000");
    assert.ok(!written.includes("PORT=8000"), "old value should be replaced");

    await new Promise<void>(r => setTimeout(r, 300));
    assert.equal(killSpy.mock.callCount(), 1);
    const [pid, sig] = killSpy.mock.calls[0].arguments as [number, string];
    assert.equal(pid, process.pid);
    assert.equal(sig, "SIGTERM");
  } finally {
    existsSpy.mock.restore();
    readSpy.mock.restore();
    writeSpy.mock.restore();
    killSpy.mock.restore();
  }
});

test("PATCH /config: appends port when key is absent from .env", async () => {
  const app = await buildApp();
  const existsSpy = mock.method(fs, "existsSync",   () => true);
  const readSpy   = mock.method(fs, "readFileSync",  () => "NODE_ENV=development\n");
  const writeSpy  = mock.method(fs, "writeFileSync", () => {});
  const killSpy   = mock.method(process, "kill",     () => {});
  try {
    await app.inject({
      method:  "PATCH",
      url:     "/config",
      headers: JSON_HEADERS,
      payload: JSON.stringify({ apiPort: 9000 }),
    });
    assert.equal(writeSpy.mock.callCount(), 1);
    const written = writeSpy.mock.calls[0].arguments[1] as string;
    assert.ok(written.includes("PORT=9000"), "PORT=9000 should be appended");
    assert.ok(written.includes("NODE_ENV=development"), "existing content preserved");
  } finally {
    existsSpy.mock.restore();
    readSpy.mock.restore();
    writeSpy.mock.restore();
    killSpy.mock.restore();
  }
});

test("PATCH /config: omitting apiPort skips write but still returns 202", async () => {
  const app = await buildApp();
  const writeSpy = mock.method(fs, "writeFileSync", () => {});
  const killSpy  = mock.method(process, "kill",     () => {});
  try {
    const res = await app.inject({
      method:  "PATCH",
      url:     "/config",
      headers: JSON_HEADERS,
      payload: JSON.stringify({}),
    });
    assert.equal(res.statusCode, 202);
    assert.equal(writeSpy.mock.callCount(), 0);
    // Route always schedules SIGTERM — wait for it before restoring the mock
    // so the real process.kill is not called while the timer is still pending.
    await new Promise<void>(r => setTimeout(r, 300));
  } finally {
    process.exitCode = 0;
    writeSpy.mock.restore();
    killSpy.mock.restore();
  }
});

test("PATCH /config: port below 1024 returns 400", async () => {
  const app = await buildApp();
  const res = await app.inject({
    method:  "PATCH",
    url:     "/config",
    headers: JSON_HEADERS,
    payload: JSON.stringify({ apiPort: 80 }),
  });
  assert.equal(res.statusCode, 400);
});

test("PATCH /config: port above 65535 returns 400", async () => {
  const app = await buildApp();
  const res = await app.inject({
    method:  "PATCH",
    url:     "/config",
    headers: JSON_HEADERS,
    payload: JSON.stringify({ apiPort: 99999 }),
  });
  assert.equal(res.statusCode, 400);
});

test("PATCH /config: non-integer port returns 400", async () => {
  const app = await buildApp();
  const res = await app.inject({
    method:  "PATCH",
    url:     "/config",
    headers: JSON_HEADERS,
    payload: JSON.stringify({ apiPort: 8000.5 }),
  });
  assert.equal(res.statusCode, 400);
});

test("PATCH /config: returns 403 in production", async () => {
  const app = await buildApp({ nodeEnv: "production" });
  const res = await app.inject({
    method:  "PATCH",
    url:     "/config",
    headers: JSON_HEADERS,
    payload: JSON.stringify({ apiPort: 9000 }),
  });
  assert.equal(res.statusCode, 403);
});

test("PATCH /config: unauthenticated returns 401", async () => {
  const app = await buildApp();
  const res = await app.inject({
    method:  "PATCH",
    url:     "/config",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ apiPort: 9000 }),
  });
  assert.equal(res.statusCode, 401);
});
