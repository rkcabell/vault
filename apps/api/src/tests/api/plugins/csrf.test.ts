import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import csrfPlugin from "@/plugins/csrf.js";

const ORIGIN = "https://vault.example.com";

const appsToClose: FastifyInstance[] = [];
test.after(async () => {
  await Promise.all(appsToClose.map(app => app.close()));
});

async function buildApp (csrfAllowedOrigins: string[] | null) {
  const app = Fastify({ logger: false });
  (app as any).decorate("config", { csrfAllowedOrigins });
  await app.register(csrfPlugin);

  // Every method the check distinguishes, on one url, so a test names only the
  // method it cares about.
  for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const) {
    app.route({ method, url: "/thing", handler: async () => ({ reached: true }) });
  }

  appsToClose.push(app);
  return app;
}

test("a POST from an allowed origin reaches the handler", async () => {
  const app = await buildApp([ORIGIN]);
  const res = await app.inject({ method: "POST", url: "/thing", headers: { origin: ORIGIN } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().reached, true);
});

test("a POST from another origin is refused before the handler runs", async () => {
  const app = await buildApp([ORIGIN]);
  const res = await app.inject({
    method: "POST", url: "/thing",
    headers: { origin: "https://evil.example.com" },
  });
  assert.equal(res.statusCode, 403);
  assert.match(res.json().message, /evil\.example\.com/);
});

test("every state-changing method is covered, not just POST", async () => {
  const app = await buildApp([ORIGIN]);
  for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
    const res = await app.inject({
      method, url: "/thing",
      headers: { origin: "https://evil.example.com" },
    });
    assert.equal(res.statusCode, 403, method);
  }
});

test("reads are exempt — a browser sends no Origin on them", async () => {
  const app = await buildApp([ORIGIN]);
  for (const method of ["GET", "HEAD"] as const) {
    const res = await app.inject({
      method, url: "/thing",
      headers: { origin: "https://evil.example.com" },
    });
    assert.equal(res.statusCode, 200, method);
  }
});

test("a request with neither header passes — that is a non-browser client", async () => {
  const app = await buildApp([ORIGIN]);
  const res = await app.inject({ method: "POST", url: "/thing" });
  assert.equal(res.statusCode, 200);
});

test("Referer is the fallback when Origin is missing", async () => {
  const app = await buildApp([ORIGIN]);
  const allowed = await app.inject({
    method: "POST", url: "/thing",
    headers: { referer: `${ORIGIN}/library` },
  });
  const refused = await app.inject({
    method: "POST", url: "/thing",
    headers: { referer: "https://evil.example.com/x" },
  });
  assert.equal(allowed.statusCode, 200);
  assert.equal(refused.statusCode, 403);
});

test("a null allow-list installs no hook at all", async () => {
  const app = await buildApp(null);
  const res = await app.inject({
    method: "POST", url: "/thing",
    headers: { origin: "https://evil.example.com" },
  });
  assert.equal(res.statusCode, 200);
});
