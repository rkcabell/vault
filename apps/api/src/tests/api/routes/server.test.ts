// The GET /workers shape test needs Redis; run `pnpm run localdocker` to
// exercise it for real. Without Redis it is skipped, not left to run: the
// handler builds BullMQ queues, and ioredis retries a refused connection
// forever, so an unguarded request neither resolves nor rejects and takes the
// whole file down with it. Every other test here runs unconditionally.
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { existsSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { canonicalizeAbsPath } from "@/lib/media/indexRoots.js";
import sensible from "@fastify/sensible";
import { serverRoutes } from "@/routes/server.js";

const REDIS_URL = "redis://localhost:6379";

process.env.REDIS_URL   = REDIS_URL;
process.env.OCR_QUEUE   = "ocr_queue";
process.env.THUMB_QUEUE = "thumb_queue";

// ── mock helpers ──────────────────────────────────────────────────────────────

interface BuildOpts {
  nodeEnv?: string;
  /** Make every limiter refuse, to assert a guard is in a route's chain. */
  rateLimited?: boolean;
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
    REDIS_URL,
  });

  // /fs/list and /fs/mkdir attach a limiter at registration time, so this has to
  // exist before the route plugin loads. No-op unless a test asks otherwise.
  (app as any).decorate("userRateLimit", () => async (_req: any, reply: any) => {
    if (opts.rateLimited) return reply.code(429).send({ error: "rate_limited" });
  });

  await app.register(serverRoutes);
  return app;
}

const AUTH = { authorization: "Bearer test-token" };

/**
 * Bounded liveness probe for Redis. Opens a socket, sends an inline PING, and
 * treats any reply as proof Redis is answering — an auth error still means it
 * is there. Deliberately raw TCP rather than ioredis/BullMQ, because those are
 * what retry indefinitely; a probe that can hang is no probe at all.
 */
function redisReachable (url: string, timeoutMs = 2_000): Promise<boolean> {
  const { hostname, port } = new URL(url);
  return new Promise(resolve => {
    const socket = net.connect({ host: hostname, port: port ? Number(port) : 6379 });
    const settle = (reachable: boolean) => {
      socket.destroy();
      resolve(reachable);
    };
    // Covers both a stalled connect and a connect that never gets answered.
    socket.setTimeout(timeoutMs);
    socket.on("connect", () => socket.write("PING\r\n"));
    socket.on("data",    () => settle(true));
    socket.on("timeout", () => settle(false));
    socket.on("error",   () => settle(false));
  });
}

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

type WorkerArm = {
  active: boolean;
  count:  number;
  counts: { waiting: number; active: number; delayed: number; failed: number };
};

// A ceiling, not a performance budget: it only has to be shorter than "forever"
// so a Redis that accepts connections but then stops answering fails the run
// instead of wedging it.
const REDIS_TEST_TIMEOUT_MS = 15_000;

test("GET /workers: returns worker activity shape (requires Redis)", { timeout: REDIS_TEST_TIMEOUT_MS }, async (t) => {
  if (!await redisReachable(REDIS_URL)) {
    t.skip(`Redis unreachable at ${REDIS_URL} — run \`pnpm run localdocker\``);
    return;
  }

  const app = await buildApp();
  const res = await app.inject({ method: "GET", url: "/workers", headers: AUTH });
  assert.equal(res.statusCode, 200);
  // text and ocr are separate queues since 15A; both must be reported.
  const body = res.json() as { text: WorkerArm; ocr: WorkerArm; thumb: WorkerArm };

  // Verify response shape — actual active/count values depend on running workers
  for (const arm of ["text", "ocr", "thumb"] as const) {
    const got = body[arm];
    assert.ok(got, `missing ${arm} arm`);
    // `active` means a worker is listening; `counts.active` means jobs in
    // flight. Asserting both catches a regression that swaps the two.
    assert.equal(typeof got.active, "boolean", `${arm}.active`);
    assert.equal(typeof got.count, "number", `${arm}.count`);
    assert.ok(got.count >= 0, `${arm}.count >= 0`);
    for (const key of ["waiting", "active", "delayed", "failed"] as const) {
      assert.equal(typeof got.counts[key], "number", `${arm}.counts.${key}`);
      assert.ok(got.counts[key] >= 0, `${arm}.counts.${key} >= 0`);
    }
  }
});

test("GET /workers: unauthenticated returns 401", async () => {
  const app = await buildApp();
  const res = await app.inject({ method: "GET", url: "/workers" });
  assert.equal(res.statusCode, 401);
});

// ── /fs rate limiting ─────────────────────────────────────────────────────────

// The folder picker walks the server's own filesystem, and mkdir writes to it.
// Asserts the guard is in each chain, not the bucket's size.
test("the /fs routes refuse when the limiter does", async () => {
  const app = await buildApp({ rateLimited: true });

  const list = await app.inject({ method: "GET", url: "/fs/list", headers: AUTH });
  assert.equal(list.statusCode, 429);

  const made = await app.inject({
    method: "POST", url: "/fs/mkdir",
    headers: { ...AUTH, "content-type": "application/json" },
    payload: JSON.stringify({ parent: os.tmpdir(), name: "vault-limiter-test" }),
  });
  assert.equal(made.statusCode, 429);
});

// ── POST /fs/mkdir — where it will and won't create ───────────────────────────

const mkdirBody = (parent: unknown, name: unknown) => ({
  method: "POST" as const,
  url: "/fs/mkdir",
  headers: { ...AUTH, "content-type": "application/json" },
  payload: JSON.stringify({ parent, name }),
});

test("POST /fs/mkdir: creates the folder and answers with its path", async () => {
  const app = await buildApp();
  const parent = await mkdtemp(path.join(os.tmpdir(), "vault-mkdir-"));
  try {
    const res = await app.inject(mkdirBody(parent, "made-here"));
    assert.equal(res.statusCode, 201);
    assert.equal(res.json().path, path.join(canonicalizeAbsPath(parent), "made-here"));
    assert.ok(existsSync(path.join(parent, "made-here")));
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

// The hole this route had: `path.resolve` reads a relative parent against the
// API's own cwd, so this used to create a directory beside the source tree.
//
// The name is unique per run and swept afterwards: against a build without the
// guard this route genuinely creates these, and a leftover from one failed run
// would otherwise fail every run after it for a reason that no longer exists.
test("POST /fs/mkdir: a relative parent is refused, not resolved against cwd", async () => {
  const app = await buildApp();
  const parents = ["..", ".", "logs", "../../elsewhere"];
  const marker = `vault-escape-${randomUUID().slice(0, 8)}`;
  const wouldBe = parents.map(p => path.resolve(p, marker));
  try {
    for (const parent of parents) {
      const res = await app.inject(mkdirBody(parent, marker));
      assert.equal(res.statusCode, 400, parent);
      assert.match(res.json().message, /absolute/i, parent);
    }
    for (const p of wouldBe) assert.equal(existsSync(p), false, p);
  } finally {
    // rmdir, not rm -r: it refuses anything that isn't the empty directory the
    // route would have made.
    for (const p of wouldBe) { try { rmdirSync(p); } catch { /* guard held */ } }
  }
});

// Reach is bounded to the drive roots /fs/list enumerates. A raw UNC path is
// under none of them; a mapped network drive has a letter and is unaffected.
test("POST /fs/mkdir: a parent on no known drive is refused", async () => {
  const app = await buildApp();
  const offRoot = process.platform === "win32" ? "\\\\nas\\share" : " /nowhere";
  const res = await app.inject(mkdirBody(offRoot, "nope"));
  assert.equal(res.statusCode, 400);
});

test("POST /fs/mkdir: traversal in `name` is still refused", async () => {
  const app = await buildApp();
  for (const name of ["..", ".", "a/b", "a\\b", "", "  "]) {
    const res = await app.inject(mkdirBody(os.tmpdir(), name));
    assert.equal(res.statusCode, 400, JSON.stringify(name));
  }
});

// Windows raises ENOENT here where POSIX raises ENOTDIR, so the status differs
// by platform. Both are mapped; what matters is that neither reaches the 500.
test("POST /fs/mkdir: a parent that is a file is handled, not a crash", async () => {
  const app = await buildApp();
  const dir = await mkdtemp(path.join(os.tmpdir(), "vault-mkdir-"));
  const file = path.join(dir, "not-a-dir");
  try {
    writeFileSync(file, "x");
    const res = await app.inject(mkdirBody(file, "child"));
    assert.ok([400, 404].includes(res.statusCode), `got ${res.statusCode}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("POST /fs/mkdir: unauthenticated returns 401", async () => {
  const app = await buildApp();
  const res = await app.inject({
    method: "POST", url: "/fs/mkdir",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ parent: os.tmpdir(), name: "nope" }),
  });
  assert.equal(res.statusCode, 401);
});
