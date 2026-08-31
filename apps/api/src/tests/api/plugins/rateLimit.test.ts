import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import rateLimitPlugin from "@/plugins/rateLimit.js";

/** ZADD on an existing member updates its score instead of adding a row.
 *  Modelling that is what makes the millisecond-collision test meaningful. */
function createFakeRedis (opts: { execReturnsNull?: boolean; zcardFails?: boolean } = {}) {
  const sets = new Map<string, Map<string, number>>();
  const ttls = new Map<string, number>();
  const setFor = (k: string) => {
    let s = sets.get(k);
    if (!s) { s = new Map(); sets.set(k, s); }
    return s;
  };

  return {
    multi () {
      const ops: Array<() => unknown> = [];
      const api = {
        zremrangebyscore (k: string, min: number, max: number) {
          ops.push(() => {
            const s = setFor(k);
            for (const [member, score] of s) if (score >= min && score <= max) s.delete(member);
            return 0;
          });
          return api;
        },
        zadd (k: string, score: number, member: string) {
          ops.push(() => {
            const s = setFor(k);
            const added = s.has(member) ? 0 : 1;
            s.set(member, score);
            return added;
          });
          return api;
        },
        zcard (k: string) {
          ops.push(() => setFor(k).size);
          return api;
        },
        pexpire (k: string, ms: number) {
          ops.push(() => { ttls.set(k, ms); return 1; });
          return api;
        },
        async exec () {
          if (opts.execReturnsNull) return null;
          const results = ops.map(op => [null, op()] as [Error | null, unknown]);
          if (opts.zcardFails) results[2] = [new Error("READONLY"), null];
          return results;
        },
      };
      return api;
    },
    async pttl (k: string) {
      return ttls.get(k) ?? -2;
    },
  };
}

const appsToClose: FastifyInstance[] = [];
test.after(async () => {
  await Promise.all(appsToClose.map(app => app.close()));
});

async function buildApp (redis: unknown, bucket: { limit: number; windowMs: number }) {
  const app = Fastify({ logger: false });
  (app as any).decorate("redis", redis);
  await app.register(rateLimitPlugin);
  app.get("/thing", { preHandler: [app.rateLimit({ key: "bucket", ...bucket })] }, async () => ({ ok: true }));
  appsToClose.push(app);
  return app;
}

/** Pins a run to one millisecond — the case a bare-timestamp member can't count. */
async function atInstant<T> (now: number, fn: () => Promise<T>): Promise<T> {
  const real = Date.now;
  Date.now = () => now;
  try {
    return await fn();
  } finally {
    Date.now = real;
  }
}

const statuses = (res: Array<{ statusCode: number }>) => {
  const ok = res.filter(r => r.statusCode === 200).length;
  return { ok, limited: res.length - ok };
};

test("concurrent requests in a single millisecond each count against the bucket", async () => {
  const app = await buildApp(createFakeRedis(), { limit: 5, windowMs: 60_000 });

  const res = await atInstant(1_700_000_000_000, () =>
    Promise.all(Array.from({ length: 12 }, () => app.inject({ method: "GET", url: "/thing" }))));

  assert.deepEqual(statuses(res), { ok: 5, limited: 7 });
});

test("the bucket is exact: the limit-th request passes and the next is refused", async () => {
  const app = await buildApp(createFakeRedis(), { limit: 3, windowMs: 60_000 });

  await atInstant(1_700_000_000_000, async () => {
    for (let i = 1; i <= 3; i++) {
      const res = await app.inject({ method: "GET", url: "/thing" });
      assert.equal(res.statusCode, 200, `request ${i}`);
    }
    const refused = await app.inject({ method: "GET", url: "/thing" });
    assert.equal(refused.statusCode, 429);
    assert.equal(refused.json().error, "rate_limited");
    assert.ok(Number(refused.headers["retry-after"]) > 0);
  });
});

test("a request past the window start is dropped, freeing the bucket", async () => {
  const t0 = 1_700_000_000_000;
  const app = await buildApp(createFakeRedis(), { limit: 2, windowMs: 60_000 });

  await atInstant(t0, () => Promise.all([
    app.inject({ method: "GET", url: "/thing" }),
    app.inject({ method: "GET", url: "/thing" }),
  ]));
  const blocked = await atInstant(t0, () => app.inject({ method: "GET", url: "/thing" }));
  const afterWindow = await atInstant(t0 + 60_001, () => app.inject({ method: "GET", url: "/thing" }));

  assert.equal(blocked.statusCode, 429);
  assert.equal(afterWindow.statusCode, 200);
});

test("separate keys do not share a bucket", async () => {
  const redis = createFakeRedis();
  const app = Fastify({ logger: false });
  (app as any).decorate("redis", redis);
  await app.register(rateLimitPlugin);
  app.get("/a", { preHandler: [app.rateLimit({ key: "a", limit: 1, windowMs: 60_000 })] }, async () => ({ ok: true }));
  app.get("/b", { preHandler: [app.rateLimit({ key: "b", limit: 1, windowMs: 60_000 })] }, async () => ({ ok: true }));
  appsToClose.push(app);

  await atInstant(1_700_000_000_000, async () => {
    assert.equal((await app.inject({ method: "GET", url: "/a" })).statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: "/b" })).statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: "/a" })).statusCode, 429);
  });
});

// Both Redis failure modes fail open on purpose — see the plugin.
test("a null pipeline result lets the request through", async () => {
  const app = await buildApp(createFakeRedis({ execReturnsNull: true }), { limit: 1, windowMs: 60_000 });
  const res = await Promise.all(Array.from({ length: 5 }, () => app.inject({ method: "GET", url: "/thing" })));
  assert.deepEqual(statuses(res), { ok: 5, limited: 0 });
});

test("a failed ZCARD lets the request through", async () => {
  const app = await buildApp(createFakeRedis({ zcardFails: true }), { limit: 1, windowMs: 60_000 });
  const res = await Promise.all(Array.from({ length: 5 }, () => app.inject({ method: "GET", url: "/thing" })));
  assert.deepEqual(statuses(res), { ok: 5, limited: 0 });
});

test("userRateLimit buckets per account, not per route", async () => {
  const redis = createFakeRedis();
  const app = Fastify({ logger: false });
  (app as any).decorate("redis", redis);
  await app.register(rateLimitPlugin);
  const guard = app.userRateLimit("scan", { limit: 1, windowMs: 60_000 });
  app.get("/one", { preHandler: [guard] }, async () => ({ ok: true }));
  app.get("/two", { preHandler: [guard] }, async () => ({ ok: true }));
  app.addHook("onRequest", async req => { (req as any).userId = "user-1"; });
  appsToClose.push(app);

  await atInstant(1_700_000_000_000, async () => {
    assert.equal((await app.inject({ method: "GET", url: "/one" })).statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: "/two" })).statusCode, 429);
  });
});
