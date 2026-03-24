import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import sensible from "@fastify/sensible";
import { tagsRoutes } from "@/routes/tags.js";

// ── mock helpers ──────────────────────────────────────────────────────────────

type TagRow = { name: string; count: number; color: string | null };

interface PrismaMockOpts {
  tagFindMany?: (_args?: unknown) => Promise<TagRow[]>;
  tagCount?: () => Promise<number>;
  tagUpdateMany?: (_args: unknown) => Promise<unknown>;
  // Interactive-transaction overrides (used by renameTag / deleteTag)
  txQueryRaw?: (..._args: unknown[]) => Promise<unknown>;
  txExecuteRaw?: (..._args: unknown[]) => Promise<number>;
  txTagFindUnique?: (_args: unknown) => Promise<{ name: string; count: number } | null>;
  txTagUpdate?: (_args: unknown) => Promise<unknown>;
  txTagDelete?: (_args: unknown) => Promise<unknown>;
  txTagDeleteMany?: (_args: unknown) => Promise<unknown>;
}

function makePrisma({
  tagFindMany = async () => [],
  tagCount = async () => 0,
  tagUpdateMany = async () => ({}),
  txQueryRaw = async () => [],
  txExecuteRaw = async () => 0,
  txTagFindUnique = async () => null,
  txTagUpdate = async () => ({}),
  txTagDelete = async () => ({}),
  txTagDeleteMany = async () => ({}),
}: PrismaMockOpts = {}) {
  // The tx object passed into interactive ($transaction(fn)) callbacks.
  const tx = {
    $queryRaw: txQueryRaw,
    $executeRaw: txExecuteRaw,
    tag: {
      findUnique: txTagFindUnique,
      update: txTagUpdate,
      delete: txTagDelete,
      deleteMany: txTagDeleteMany,
    },
  };

  return {
    tag: {
      findMany: tagFindMany,
      count: tagCount,
      updateMany: tagUpdateMany,
    },
    $transaction: (arg: unknown) => {
      // Array form: listTopTags passes [findMany(…), count(…)]
      if (Array.isArray(arg)) return Promise.all(arg as Promise<unknown>[]);
      // Callback form: deleteTag / renameTag pass an async function
      if (typeof arg === "function") return (arg as (_tx: unknown) => Promise<unknown>)(tx);
      throw new Error("unexpected $transaction argument");
    },
  };
}

async function buildApp(opts: PrismaMockOpts = {}) {
  const app = Fastify({ logger: false });

  await app.register(sensible);

  // Minimal jwt decorator — verifyAccess just returns a valid payload
   
  (app as any).decorate("jwt", {
    verifyAccess: () => ({ sub: "user-1" }),
    signAccess: () => "",
    signRefresh: () => "",
    verifyRefresh: () => ({ sub: "user-1" }),
  });

   
  (app as any).decorate("prisma", makePrisma(opts));

  await app.register(tagsRoutes);
  return app;
}

const AUTH = { authorization: "Bearer test-token" };
const JSON_HEADERS = { ...AUTH, "content-type": "application/json" };

// ── GET / ─────────────────────────────────────────────────────────────────────

test("GET /: returns tags with pagination metadata", async () => {
  const app = await buildApp({
    tagFindMany: async () => [
      { name: "photo", count: 5, color: "#ff0000" },
      { name: "work", count: 2, color: null },
    ],
    tagCount: async () => 2,
  });

  const res = await app.inject({ method: "GET", url: "/", headers: AUTH });

  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.tags, [
    { name: "photo", count: 5, color: "#ff0000" },
    { name: "work", count: 2, color: null },
  ]);
  assert.equal(body.total, 2);
  assert.equal(body.offset, 0);
  assert.equal(body.limit, 30);
});

test("GET /: applies limit and offset query params", async () => {
  let capturedArgs: unknown;
  const app = await buildApp({
    tagFindMany: async (args: unknown) => { capturedArgs = args; return []; },
    tagCount: async () => 0,
  });

  const res = await app.inject({ method: "GET", url: "/?limit=10&offset=5", headers: AUTH });

  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.limit, 10);
  assert.equal(body.offset, 5);
  // Repository receives the correct take/skip
  assert.equal((capturedArgs as { take: number }).take, 10);
  assert.equal((capturedArgs as { skip: number }).skip, 5);
});

test("GET /: unauthenticated returns 401", async () => {
  const app = await buildApp();
  const res = await app.inject({ method: "GET", url: "/" });
  assert.equal(res.statusCode, 401);
});
test("DELETE /orphaned: removes orphan tags and returns deleted count", async () => {
  let capturedDeleteManyArgs: unknown;
  const app = await buildApp({
    txQueryRaw: async () => [{ name: "orphan-a" }, { name: "orphan-b" }],
    txTagDeleteMany: async (args) => {
      capturedDeleteManyArgs = args;
      return { count: 2 };
    },
  });

  const res = await app.inject({ method: "DELETE", url: "/orphaned", headers: AUTH });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true, deleted: 2 });
  assert.deepEqual(capturedDeleteManyArgs, {
    where: { userId: "user-1", name: { in: ["orphan-a", "orphan-b"] } },
  });
});

test("DELETE /orphaned: returns 0 when no orphan tags exist", async () => {
  let deleteManyCalled = false;
  const app = await buildApp({
    txQueryRaw: async () => [],
    txTagDeleteMany: async () => {
      deleteManyCalled = true;
      return { count: 0 };
    },
  });

  const res = await app.inject({ method: "DELETE", url: "/orphaned", headers: AUTH });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true, deleted: 0 });
  assert.equal(deleteManyCalled, false);
});

test("DELETE /orphaned: unauthenticated returns 401", async () => {
  const app = await buildApp();
  const res = await app.inject({ method: "DELETE", url: "/orphaned" });
  assert.equal(res.statusCode, 401);
});

// ── DELETE /:tag ───────────────────────────────────────────────────────────────

test("DELETE /:tag: removes tag and returns affected count", async () => {
  const app = await buildApp({ txExecuteRaw: async () => 4 });

  const res = await app.inject({ method: "DELETE", url: "/photo", headers: AUTH });

  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.tag, "photo");
  assert.equal(body.affected, 4);
});

test("DELETE /:tag: normalizes tag param before deleting", async () => {
  let deletedTag = "";
  const app = await buildApp({
    txTagDeleteMany: async (args) => {
      deletedTag = (args as { where: { name: string } }).where.name;
      return {};
    },
  });

  // "Photo" should be normalized to "photo"
  await app.inject({ method: "DELETE", url: "/Photo", headers: AUTH });
  assert.equal(deletedTag, "photo");
});

test("DELETE /:tag: invalid tag param returns 400", async () => {
  const app = await buildApp();
  const res = await app.inject({ method: "DELETE", url: "/car%24tag", headers: AUTH });
  assert.equal(res.statusCode, 400);
});

test("DELETE /:tag: unauthenticated returns 401", async () => {
  const app = await buildApp();
  const res = await app.inject({ method: "DELETE", url: "/photo" });
  assert.equal(res.statusCode, 401);
});

// ── PATCH /:tag — rename ───────────────────────────────────────────────────────

test("PATCH /:tag: renames tag and returns affected count", async () => {
  const app = await buildApp({ txExecuteRaw: async () => 7 });

  const res = await app.inject({
    method: "PATCH",
    url: "/old-tag",
    headers: JSON_HEADERS,
    payload: JSON.stringify({ name: "new-tag" }),
  });

  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.tag, "old-tag");
  assert.equal(body.newName, "new-tag");
  assert.equal(body.affected, 7);
});

test("PATCH /:tag: rename is a no-op when normalized new name matches current", async () => {
  // "Old Tag" normalizes to "old-tag", same as the :tag param
  let renameCalled = false;
  const app = await buildApp({
    txExecuteRaw: async () => { renameCalled = true; return 0; },
  });

  const res = await app.inject({
    method: "PATCH",
    url: "/old-tag",
    headers: JSON_HEADERS,
    payload: JSON.stringify({ name: "Old Tag" }),
  });

  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.newName, "old-tag");
  assert.equal(renameCalled, false, "renameTag should not be called for a no-op");
});

test("PATCH /:tag: invalid tag param returns 400", async () => {
  const app = await buildApp();
  const res = await app.inject({
    method: "PATCH",
    url: "/car%24tag",
    headers: JSON_HEADERS,
    payload: JSON.stringify({ name: "other" }),
  });
  assert.equal(res.statusCode, 400);
});

test("PATCH /:tag: invalid new name returns 400", async () => {
  const app = await buildApp();
  const res = await app.inject({
    method: "PATCH",
    url: "/photo",
    headers: JSON_HEADERS,
    payload: JSON.stringify({ name: "bad$name" }),
  });
  assert.equal(res.statusCode, 400);
});

// ── PATCH /:tag — color ───────────────────────────────────────────────────────

test("PATCH /:tag: sets tag color", async () => {
  let setColor: string | null | undefined;
  const app = await buildApp({
    tagUpdateMany: async (args) => {
      setColor = (args as { data: { color: string | null } }).data.color;
      return {};
    },
  });

  const res = await app.inject({
    method: "PATCH",
    url: "/photo",
    headers: JSON_HEADERS,
    payload: JSON.stringify({ color: "#aabbcc" }),
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().ok, true);
  assert.equal(setColor, "#aabbcc");
});

test("PATCH /:tag: clears tag color with null", async () => {
  let setColor: string | null | undefined = "not-set";
  const app = await buildApp({
    tagUpdateMany: async (args) => {
      setColor = (args as { data: { color: string | null } }).data.color;
      return {};
    },
  });

  const res = await app.inject({
    method: "PATCH",
    url: "/photo",
    headers: JSON_HEADERS,
    payload: JSON.stringify({ color: null }),
  });

  assert.equal(res.statusCode, 200);
  assert.equal(setColor, null);
});

test("PATCH /:tag: invalid color format returns 400", async () => {
  const app = await buildApp();
  const res = await app.inject({
    method: "PATCH",
    url: "/photo",
    headers: JSON_HEADERS,
    payload: JSON.stringify({ color: "notacolor" }),
  });
  assert.equal(res.statusCode, 400);
});

// ── PATCH /:tag — missing body ─────────────────────────────────────────────────

test("PATCH /:tag: returns 400 when neither name nor color is provided", async () => {
  const app = await buildApp();
  const res = await app.inject({
    method: "PATCH",
    url: "/photo",
    headers: JSON_HEADERS,
    payload: JSON.stringify({}),
  });
  assert.equal(res.statusCode, 400);
});


