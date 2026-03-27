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
};

interface PrismaMockOpts {
  userFindUnique?: (args: unknown) => Promise<UserRow | null>;
  userFindFirst?: (args: unknown) => Promise<{ id: string; email: string } | null>;
  userCreate?: (args: unknown) => Promise<{ id: string; email: string }>;
  userUpdate?: (args: unknown) => Promise<unknown>;
}

interface JwtMockOpts {
  signAccess?: (payload: { sub: string }) => string;
  signRefresh?: (payload: { sub: string }) => string;
  verifyAccess?: (token: string) => { sub: string };
  verifyRefresh?: (token: string) => { sub: string };
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

async function buildApp(opts: { prisma?: PrismaMockOpts; jwt?: JwtMockOpts } = {}) {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  await app.register(cookie);
   
  (app as any).decorate("prisma", makePrisma(opts.prisma));
   
  (app as any).decorate("jwt", makeJwt(opts.jwt));
   
  (app as any).decorate("rateLimit", () => async () => {});
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

test("POST /refresh: valid token returns new access token", async () => {
  const app = await buildApp({
    jwt: {
      verifyRefresh: () => ({ sub: "user-1" }),
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

// ── POST /forgot-password ─────────────────────────────────────────────────────

test("POST /forgot-password: known email returns token", async () => {
  const app = await buildApp({
    prisma: {
      userFindUnique: async () => ({
        id: "user-1", email: "u@example.com", passwordHash: "h", name: null, username: null,
      }),
      userUpdate: async () => ({}),
    },
  });

  const res = await app.inject({
    method: "POST",
    url: "/forgot-password",
    headers: JSON_CT,
    payload: JSON.stringify({ email: "u@example.com" }),
  });

  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(typeof body.token === "string" && body.token.length > 0, "token must be a non-empty string");
});

test("POST /forgot-password: unknown email returns empty object (no token leakage)", async () => {
  const app = await buildApp({
    prisma: { userFindUnique: async () => null },
  });

  const res = await app.inject({
    method: "POST",
    url: "/forgot-password",
    headers: JSON_CT,
    payload: JSON.stringify({ email: "nobody@example.com" }),
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), {});
});

test("POST /forgot-password: invalid email format returns empty object (not 400)", async () => {
  const app = await buildApp();

  const res = await app.inject({
    method: "POST",
    url: "/forgot-password",
    headers: JSON_CT,
    payload: JSON.stringify({ email: "not-an-email" }),
  });

  // Route silently ignores invalid input to avoid user enumeration
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), {});
});

// ── POST /reset-password ──────────────────────────────────────────────────────

test("POST /reset-password: valid token and password returns success message", async () => {
  const app = await buildApp({
    prisma: {
      userFindFirst: async () => ({ id: "user-1", email: "u@example.com" }),
      userUpdate: async () => ({}),
    },
  });

  const res = await app.inject({
    method: "POST",
    url: "/reset-password",
    headers: JSON_CT,
    payload: JSON.stringify({ token: "valid-reset-token", password: "newpassword1" }),
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().message, "Password updated");
});

test("POST /reset-password: unknown or expired token returns 400", async () => {
  const app = await buildApp({
    prisma: { userFindFirst: async () => null },
  });

  const res = await app.inject({
    method: "POST",
    url: "/reset-password",
    headers: JSON_CT,
    payload: JSON.stringify({ token: "expired-token", password: "newpassword1" }),
  });

  assert.equal(res.statusCode, 400);
  assert.match(res.json().message, /invalid or has expired/i);
});

test("POST /reset-password: short password returns 400", async () => {
  const app = await buildApp();

  const res = await app.inject({
    method: "POST",
    url: "/reset-password",
    headers: JSON_CT,
    payload: JSON.stringify({ token: "some-token", password: "short" }),
  });

  assert.equal(res.statusCode, 400);
  assert.match(res.json().message, /8 characters/i);
});

test("POST /reset-password: missing token field returns 400", async () => {
  const app = await buildApp();

  const res = await app.inject({
    method: "POST",
    url: "/reset-password",
    headers: JSON_CT,
    payload: JSON.stringify({ password: "newpassword1" }),
  });

  assert.equal(res.statusCode, 400);
});
