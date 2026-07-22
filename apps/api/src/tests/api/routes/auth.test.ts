import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import sensible from "@fastify/sensible";
import cookie from "@fastify/cookie";
import argon2 from "argon2";
import { authRoutes } from "@/routes/auth.js";

// ── mock helpers ──────────────────────────────────────────────────────────────

type UserRow = {
  id: string;
  email: string;
  passwordHash: string;
  name: string | null;
  username: string | null;
  avatarUrl?: string | null;
  tokenVersion?: number;
};

interface PrismaMockOpts {
  userFindUnique?: (args: unknown) => Promise<UserRow | null>;
  userFindFirst?: (args: unknown) => Promise<{ id: string; email: string } | null>;
  userCreate?: (args: unknown) => Promise<{ id: string; email: string }>;
  userUpdate?: (args: unknown) => Promise<unknown>;
}

interface JwtMockOpts {
  signAccess?: (payload: { sub: string; tv?: number }) => string;
  signRefresh?: (payload: { sub: string; tv?: number }) => string;
  verifyAccess?: (token: string) => { sub: string; tv?: number };
  verifyRefresh?: (token: string) => { sub: string; tv?: number };
}

function makePrisma({
  userFindUnique = async () => null,
  userFindFirst = async () => null,
  userCreate = async () => ({ id: "user-1", email: "u@example.com" }),
  userUpdate = async () => ({}),
}: PrismaMockOpts = {}) {
  return {
    user: {
      findUnique: userFindUnique,
      findFirst: userFindFirst,
      create: userCreate,
      update: userUpdate,
    },
  };
}

function makeJwt({
  signAccess = () => "access-tok",
  signRefresh = () => "refresh-tok",
  verifyAccess = () => ({ sub: "user-1" }),
  verifyRefresh = () => ({ sub: "user-1" }),
}: JwtMockOpts = {}) {
  return { signAccess, signRefresh, verifyAccess, verifyRefresh };
}

async function buildApp(opts: { prisma?: PrismaMockOpts; jwt?: JwtMockOpts; disableRegistration?: boolean } = {}) {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  await app.register(cookie);

  (app as any).decorate("prisma", makePrisma(opts.prisma));

  (app as any).decorate("jwt", makeJwt(opts.jwt));

  (app as any).decorate("rateLimit", () => async () => {});

  (app as any).decorate("config", { DISABLE_REGISTRATION: opts.disableRegistration ?? false });
  await app.register(authRoutes);
  return app;
}

/** Returns true if the response sets a cookie with the given name. */
function hasSetCookie(
  res: { headers: Record<string, string | string[] | number | undefined> },
  name: string,
): boolean {
  const sc = res.headers["set-cookie"];
  if (!sc) return false;
  const list = Array.isArray(sc) ? sc : [sc];
  return list.some(c => typeof c === "string" && c.startsWith(`${name}=`));
}

const JSON_CT = { "content-type": "application/json" };

// ── GET /me ───────────────────────────────────────────────────────────────────

test("GET /me: returns user when access_token cookie is present", async () => {
  const app = await buildApp({
    prisma: {
      userFindUnique: async () => ({
        id: "user-1", email: "u@example.com", passwordHash: "", name: "Tester", username: null,
      }),
    },
  });

  const res = await app.inject({
    method: "GET",
    url: "/me",
    headers: { cookie: "access_token=valid-token" },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().user.id, "user-1");
  assert.equal(res.json().user.email, "u@example.com");
});

test("GET /me: returns 401 when access_token cookie is absent", async () => {
  const app = await buildApp();
  const res = await app.inject({ method: "GET", url: "/me" });
  assert.equal(res.statusCode, 401);
});

test("GET /me: returns 401 when token verification fails", async () => {
  const app = await buildApp({
    jwt: { verifyAccess: () => { throw new Error("expired"); } },
  });

  const res = await app.inject({
    method: "GET",
    url: "/me",
    headers: { cookie: "access_token=bad-token" },
  });

  assert.equal(res.statusCode, 401);
});

test("GET /me: returns 401 when user is not found for token payload", async () => {
  const app = await buildApp({
    prisma: { userFindUnique: async () => null },
  });

  const res = await app.inject({
    method: "GET",
    url: "/me",
    headers: { cookie: "access_token=valid-token" },
  });

  assert.equal(res.statusCode, 401);
});

// ── POST /register ────────────────────────────────────────────────────────────

test("POST /register: valid body creates user and returns tokens", async () => {
  const app = await buildApp({
    prisma: {
      userFindUnique: async () => null,
      userCreate: async () => ({ id: "new-user", email: "new@example.com" }),
    },
    jwt: { signAccess: () => "acc-tok", signRefresh: () => "ref-tok" },
  });

  const res = await app.inject({
    method: "POST",
    url: "/register",
    headers: JSON_CT,
    payload: JSON.stringify({ email: "new@example.com", password: "password1234" }),
  });

  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.user.id, "new-user");
  assert.equal(body.user.email, "new@example.com");
  assert.equal(body.access, "acc-tok");
  assert.equal(body.refresh, "ref-tok");
});

test("POST /register: returns 403 when DISABLE_REGISTRATION is set", async () => {
  let created = false;
  const app = await buildApp({
    prisma: {
      userFindUnique: async () => null,
      userCreate: async () => { created = true; return { id: "x", email: "x@example.com" }; },
    },
    disableRegistration: true,
  });

  const res = await app.inject({
    method: "POST",
    url: "/register",
    headers: JSON_CT,
    payload: JSON.stringify({ email: "new@example.com", password: "password1234" }),
  });

  assert.equal(res.statusCode, 403);
  assert.equal(created, false, "no user row created while registration is disabled");
});

test("POST /register: invalid email returns 400", async () => {
  const app = await buildApp();

  const res = await app.inject({
    method: "POST",
    url: "/register",
    headers: JSON_CT,
    payload: JSON.stringify({ email: "not-an-email", password: "password1234" }),
  });

  assert.equal(res.statusCode, 400);
  assert.match(res.json().message, /invalid email/i);
});

test("POST /register: short password returns 400", async () => {
  const app = await buildApp();

  const res = await app.inject({
    method: "POST",
    url: "/register",
    headers: JSON_CT,
    payload: JSON.stringify({ email: "u@example.com", password: "short" }),
  });

  assert.equal(res.statusCode, 400);
  assert.match(res.json().message, /8 characters/i);
});

test("POST /register: existing user returns 400", async () => {
  const app = await buildApp({
    prisma: {
      userFindUnique: async () => ({
        id: "x", email: "taken@example.com", passwordHash: "h", name: null, username: null,
      }),
    },
  });

  const res = await app.inject({
    method: "POST",
    url: "/register",
    headers: JSON_CT,
    payload: JSON.stringify({ email: "taken@example.com", password: "password1234" }),
  });

  assert.equal(res.statusCode, 400);
  assert.match(res.json().message, /already exists/i);
});

// ── POST /login ───────────────────────────────────────────────────────────────

test("POST /login: valid credentials return user and set cookies", async () => {
  const hash = await argon2.hash("password1234");
  const app = await buildApp({
    prisma: {
      userFindUnique: async () => ({
        id: "user-1", email: "u@example.com", passwordHash: hash, name: null, username: null,
      }),
    },
    jwt: { signAccess: () => "acc", signRefresh: () => "ref" },
  });

  const res = await app.inject({
    method: "POST",
    url: "/login",
    headers: JSON_CT,
    payload: JSON.stringify({ email: "u@example.com", password: "password1234" }),
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().user.id, "user-1");
  assert.ok(hasSetCookie(res, "access_token"), "access_token cookie must be set");
  assert.ok(hasSetCookie(res, "refresh_token"), "refresh_token cookie must be set");
});

test("POST /login: wrong password returns 401", async () => {
  const hash = await argon2.hash("correct-password");
  const app = await buildApp({
    prisma: {
      userFindUnique: async () => ({
        id: "user-1", email: "u@example.com", passwordHash: hash, name: null, username: null,
      }),
    },
  });

  const res = await app.inject({
    method: "POST",
    url: "/login",
    headers: JSON_CT,
    payload: JSON.stringify({ email: "u@example.com", password: "wrong-password" }),
  });

  assert.equal(res.statusCode, 401);
  assert.match(res.json().message, /invalid credentials/i);
});

test("POST /login: unknown email returns 401", async () => {
  const app = await buildApp({
    prisma: { userFindUnique: async () => null },
  });

  const res = await app.inject({
    method: "POST",
    url: "/login",
    headers: JSON_CT,
    payload: JSON.stringify({ email: "nobody@example.com", password: "password1234" }),
  });

  assert.equal(res.statusCode, 401);
});

test("POST /login: invalid email body returns 400", async () => {
  const app = await buildApp();

  const res = await app.inject({
    method: "POST",
    url: "/login",
    headers: JSON_CT,
    payload: JSON.stringify({ email: "bad", password: "password1234" }),
  });

  assert.equal(res.statusCode, 400);
});

// ── POST /refresh ─────────────────────────────────────────────────────────────

test("POST /refresh: matching tokenVersion returns new access token", async () => {
  const app = await buildApp({
    prisma: { userFindUnique: async () => ({ tokenVersion: 3 }) as UserRow },
    jwt: {
      verifyRefresh: () => ({ sub: "user-1", tv: 3 }),
      signAccess: () => "new-access",
    },
  });

  const res = await app.inject({
    method: "POST",
    url: "/refresh",
    headers: JSON_CT,
    payload: JSON.stringify({ refresh: "valid-refresh-tok" }),
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().access, "new-access");
});

test("POST /refresh: stale tokenVersion is rejected (evicted by a password reset)", async () => {
  const app = await buildApp({
    // User's tokenVersion was bumped to 4 (e.g. by an admin reset) after this
    // refresh token (tv: 3) was issued.
    prisma: { userFindUnique: async () => ({ tokenVersion: 4 }) as UserRow },
    jwt: { verifyRefresh: () => ({ sub: "user-1", tv: 3 }) },
  });

  const res = await app.inject({
    method: "POST",
    url: "/refresh",
    headers: JSON_CT,
    payload: JSON.stringify({ refresh: "stale-refresh-tok" }),
  });

  assert.equal(res.statusCode, 401);
  assert.match(res.json().message, /invalid or expired/i);
});

test("POST /refresh: unknown user is rejected", async () => {
  const app = await buildApp({
    prisma: { userFindUnique: async () => null },
    jwt: { verifyRefresh: () => ({ sub: "ghost", tv: 0 }) },
  });

  const res = await app.inject({
    method: "POST",
    url: "/refresh",
    headers: JSON_CT,
    payload: JSON.stringify({ refresh: "tok" }),
  });

  assert.equal(res.statusCode, 401);
});

test("POST /refresh: invalid token returns 401", async () => {
  const app = await buildApp({
    jwt: { verifyRefresh: () => { throw new Error("expired"); } },
  });

  const res = await app.inject({
    method: "POST",
    url: "/refresh",
    headers: JSON_CT,
    payload: JSON.stringify({ refresh: "bad-tok" }),
  });

  assert.equal(res.statusCode, 401);
  assert.match(res.json().message, /invalid or expired/i);
});

test("POST /refresh: cookie-based refresh sets fresh access + refresh cookies (sliding)", async () => {
  const app = await buildApp({
    prisma: { userFindUnique: async () => ({ tokenVersion: 3 }) as UserRow },
    jwt: {
      verifyRefresh: () => ({ sub: "user-1", tv: 3 }),
      signAccess: () => "new-access",
      signRefresh: () => "new-refresh",
    },
  });

  const res = await app.inject({
    method: "POST",
    url: "/refresh",
    headers: { cookie: "refresh_token=valid-refresh-tok" },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().access, "new-access");
  assert.equal(res.json().refresh, "new-refresh");
  assert.ok(hasSetCookie(res, "access_token"), "access_token cookie must be re-set");
  assert.ok(hasSetCookie(res, "refresh_token"), "refresh_token cookie must be re-set (rotated)");
});

test("POST /refresh: missing token (no cookie, no body) returns 401", async () => {
  const app = await buildApp();
  const res = await app.inject({ method: "POST", url: "/refresh" });
  assert.equal(res.statusCode, 401);
});

test("POST /refresh: stale tokenVersion clears the auth cookies", async () => {
  const app = await buildApp({
    prisma: { userFindUnique: async () => ({ tokenVersion: 4 }) as UserRow },
    jwt: { verifyRefresh: () => ({ sub: "user-1", tv: 3 }) },
  });

  const res = await app.inject({
    method: "POST",
    url: "/refresh",
    headers: { cookie: "access_token=a; refresh_token=stale-refresh-tok" },
  });

  assert.equal(res.statusCode, 401);
  const sc = res.headers["set-cookie"];
  const list = Array.isArray(sc) ? sc : [sc];
  assert.ok(
    list.some(c => typeof c === "string" && c.startsWith("access_token=") && /expires=/i.test(c)),
    "access_token must be cleared on eviction",
  );
  assert.ok(
    list.some(c => typeof c === "string" && c.startsWith("refresh_token=") && /expires=/i.test(c)),
    "refresh_token must be cleared on eviction",
  );
});

// ── POST /logout ──────────────────────────────────────────────────────────────

test("POST /logout: clears the auth cookies", async () => {
  const app = await buildApp();

  const res = await app.inject({
    method: "POST",
    url: "/logout",
    headers: { cookie: "access_token=a; refresh_token=b" },
  });

  assert.equal(res.statusCode, 200);
  const sc = res.headers["set-cookie"];
  const list = Array.isArray(sc) ? sc : [sc];
  assert.ok(
    list.some(c => typeof c === "string" && c.startsWith("access_token=") && /expires=/i.test(c)),
    "access_token must be cleared",
  );
  assert.ok(
    list.some(c => typeof c === "string" && c.startsWith("refresh_token=") && /expires=/i.test(c)),
    "refresh_token must be cleared",
  );
});

// Self-service password reset has been removed — recovery is admin-only via the
// reset-password CLI (see src/tests/api/lib/resetPassword.test.ts). The
// /forgot-password and /reset-password routes no longer exist.
