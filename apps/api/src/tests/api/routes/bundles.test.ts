import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import sensible from "@fastify/sensible";
import { bundlesRoutes } from "@/routes/bundles.js";

// ── mock types ────────────────────────────────────────────────────────────────

interface PrismaMock {
  // bundle model
  bundleFindFirst?: (_args: unknown) => Promise<unknown>;
  bundleFindMany?: (_args: unknown) => Promise<unknown[]>;
  bundleCreate?: (_args: unknown) => Promise<unknown>;
  bundleUpdate?: (_args: unknown) => Promise<unknown>;
  bundleUpdateMany?: (_args: unknown) => Promise<{ count: number }>;
  bundleDeleteMany?: (_args: unknown) => Promise<void>;
  // bundleItem model
  bundleItemFindFirst?: (_args: unknown) => Promise<unknown>;
  bundleItemFindMany?: (_args: unknown) => Promise<unknown[]>;
  bundleItemCreateMany?: (_args: unknown) => Promise<void>;
  bundleItemUpdateMany?: (_args: unknown) => Promise<unknown>;
  bundleItemDeleteMany?: (_args: unknown) => Promise<void>;
  // media model
  mediaCount?: (_args: unknown) => Promise<number>;
  mediaUpdateMany?: (_args: unknown) => Promise<void>;
}

interface MediaServicesMock {
  deleteMedia?: (_userId: string, _mediaId: string) => Promise<void>;
  streamBulkArchive?: (_items: unknown, _raw: unknown, _log: unknown) => Promise<void>;
}

interface BuildOpts {
  prisma?: PrismaMock;
  mediaServices?: MediaServicesMock;
}

// ── mock builders ─────────────────────────────────────────────────────────────

function makePrisma({
  bundleFindFirst = async () => null,
  bundleFindMany = async () => [],
  bundleCreate = async () => ({ id: "b-1", name: "Test", description: null, createdAt: new Date(), updatedAt: new Date() }),
  bundleUpdate = async () => ({}),
  bundleUpdateMany = async () => ({ count: 1 }),
  bundleDeleteMany = async () => {},
  bundleItemFindFirst = async () => null,
  bundleItemFindMany = async () => [],
  bundleItemCreateMany = async () => {},
  bundleItemUpdateMany = async () => ({}),
  bundleItemDeleteMany = async () => {},
  mediaCount = async () => 0,
  mediaUpdateMany = async () => {},
}: PrismaMock = {}) {
  return {
    bundle: {
      findFirst: bundleFindFirst,
      findMany: bundleFindMany,
      create: bundleCreate,
      update: bundleUpdate,
      updateMany: bundleUpdateMany,
      deleteMany: bundleDeleteMany,
    },
    bundleItem: {
      findFirst: bundleItemFindFirst,
      findMany: bundleItemFindMany,
      createMany: bundleItemCreateMany,
      updateMany: bundleItemUpdateMany,
      deleteMany: bundleItemDeleteMany,
    },
    media: {
      count: mediaCount,
      updateMany: mediaUpdateMany,
    },
    $transaction: (arg: unknown) => {
      if (Array.isArray(arg)) return Promise.all(arg as Promise<unknown>[]);
      throw new Error("unexpected $transaction argument");
    },
  };
}

function makeMediaServices({
  deleteMedia = async () => {},
  streamBulkArchive = async () => {},
}: MediaServicesMock = {}) {
  return {
    actionsService: { deleteMedia, streamBulkArchive },
  };
}

async function buildApp({ prisma = {}, mediaServices = {} }: BuildOpts = {}) {
  const app = Fastify({ logger: false });
  await app.register(sensible);
   
  (app as any).decorate("jwt", {
    verifyAccess: () => ({ sub: "user-1" }),
    signAccess: () => "",
    signRefresh: () => "",
    verifyRefresh: () => ({ sub: "user-1" }),
  });
   
  (app as any).decorate("prisma", makePrisma(prisma));
   
  (app as any).decorate("mediaServices", makeMediaServices(mediaServices));
  await app.register(bundlesRoutes);
  return app;
}

const AUTH = { authorization: "Bearer test-token" };
const JSON_HEADERS = { ...AUTH, "content-type": "application/json" };

// ── GET / — list bundles ──────────────────────────────────────────────────────

test("GET /: returns bundles list", async () => {
  const app = await buildApp({
    prisma: {
      bundleFindMany: async () => [
        {
          id: "b-1", name: "Photos", description: null, starred: false,
          coverMediaId: "m-1", createdAt: new Date(), updatedAt: new Date(),
          _count: { items: 3 }, items: [{ mediaId: "m-1" }],
        },
      ],
    },
  });

  const res = await app.inject({ method: "GET", url: "/", headers: AUTH });

  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.bundles.length, 1);
  assert.equal(body.bundles[0].name, "Photos");
  assert.equal(body.bundles[0].itemCount, 3);
});

test("GET /: returns empty list", async () => {
  const app = await buildApp({ prisma: { bundleFindMany: async () => [] } });
  const res = await app.inject({ method: "GET", url: "/", headers: AUTH });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().bundles, []);
});

test("GET /: unauthenticated returns 401", async () => {
  const app = await buildApp();
  const res = await app.inject({ method: "GET", url: "/" });
  assert.equal(res.statusCode, 401);
});

// ── POST / — create bundle ────────────────────────────────────────────────────

test("POST /: creates bundle and returns 201", async () => {
  const created = { id: "b-new", name: "My Bundle", description: "desc", createdAt: new Date(), updatedAt: new Date() };
  const app = await buildApp({ prisma: { bundleCreate: async () => created } });

  const res = await app.inject({
    method: "POST", url: "/",
    headers: JSON_HEADERS,
    payload: JSON.stringify({ name: "My Bundle", description: "desc" }),
  });

  assert.equal(res.statusCode, 201);
  const body = res.json();
  assert.equal(body.bundle.id, "b-new");
  assert.equal(body.bundle.name, "My Bundle");
});

test("POST /: empty name returns 400", async () => {
  const app = await buildApp();
  const res = await app.inject({
    method: "POST", url: "/",
    headers: JSON_HEADERS,
    payload: JSON.stringify({ name: "" }),
  });
  assert.equal(res.statusCode, 400);
});

test("POST /: name over 200 chars returns 400", async () => {
  const app = await buildApp();
  const res = await app.inject({
    method: "POST", url: "/",
    headers: JSON_HEADERS,
    payload: JSON.stringify({ name: "a".repeat(201) }),
  });
  assert.equal(res.statusCode, 400);
});

test("POST /: unauthenticated returns 401", async () => {
  const app = await buildApp();
  const res = await app.inject({
    method: "POST", url: "/",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ name: "X" }),
  });
  assert.equal(res.statusCode, 401);
});

// ── GET /:id — bundle detail ──────────────────────────────────────────────────

test("GET /:id: returns bundle with items", async () => {
  const app = await buildApp({
    prisma: {
      bundleFindFirst: async () => ({
        id: "b-1", name: "Photos", description: null, starred: false,
        coverMediaId: null, sourceMediaId: null,
        createdAt: new Date(), updatedAt: new Date(),
        _count: { items: 1 },
        items: [{
          mediaId: "m-1", order: 0, addedAt: new Date(),
          media: { title: "photo.jpg", mimeType: "image/jpeg", sizeBytes: 1024, thumbState: "READY", thumbnailKey: "thumb/m-1.webp" },
        }],
      }),
    },
  });

  const res = await app.inject({ method: "GET", url: "/b-1", headers: AUTH });

  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.bundle.id, "b-1");
  assert.equal(body.bundle.items.length, 1);
  assert.equal(body.bundle.items[0].mediaId, "m-1");
});

test("GET /:id: returns 404 when bundle not found", async () => {
  const app = await buildApp({ prisma: { bundleFindFirst: async () => null } });
  const res = await app.inject({ method: "GET", url: "/missing", headers: AUTH });
  assert.equal(res.statusCode, 404);
});

test("GET /:id: unauthenticated returns 401", async () => {
  const app = await buildApp();
  const res = await app.inject({ method: "GET", url: "/b-1" });
  assert.equal(res.statusCode, 401);
});

// ── PATCH /:id — update bundle ────────────────────────────────────────────────

test("PATCH /:id: updates name and returns ok", async () => {
  const app = await buildApp({ prisma: { bundleUpdateMany: async () => ({ count: 1 }) } });
  const res = await app.inject({
    method: "PATCH", url: "/b-1",
    headers: JSON_HEADERS,
    payload: JSON.stringify({ name: "New Name" }),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().ok, true);
});

test("PATCH /:id: clears description with null", async () => {
  let passedData: unknown;
  const app = await buildApp({
    prisma: {
      bundleUpdateMany: async (args) => { passedData = (args as { data: unknown }).data; return { count: 1 }; },
    },
  });

  await app.inject({
    method: "PATCH", url: "/b-1",
    headers: JSON_HEADERS,
    payload: JSON.stringify({ description: null }),
  });

  assert.equal((passedData as { description: null }).description, null);
});

test("PATCH /:id: sets coverMediaId", async () => {
  let passedData: unknown;
  const app = await buildApp({
    prisma: {
      bundleUpdateMany: async (args) => { passedData = (args as { data: unknown }).data; return { count: 1 }; },
    },
  });

  await app.inject({
    method: "PATCH", url: "/b-1",
    headers: JSON_HEADERS,
    payload: JSON.stringify({ coverMediaId: "m-5" }),
  });

  assert.equal((passedData as { coverMediaId: string }).coverMediaId, "m-5");
});

test("PATCH /:id: clears coverMediaId with null", async () => {
  let passedData: unknown;
  const app = await buildApp({
    prisma: {
      bundleUpdateMany: async (args) => { passedData = (args as { data: unknown }).data; return { count: 1 }; },
    },
  });

  await app.inject({
    method: "PATCH", url: "/b-1",
    headers: JSON_HEADERS,
    payload: JSON.stringify({ coverMediaId: null }),
  });

  assert.equal((passedData as { coverMediaId: null }).coverMediaId, null);
});

test("PATCH /:id: returns 404 when no bundle matched", async () => {
  const app = await buildApp({ prisma: { bundleUpdateMany: async () => ({ count: 0 }) } });
  const res = await app.inject({
    method: "PATCH", url: "/missing",
    headers: JSON_HEADERS,
    payload: JSON.stringify({ name: "X" }),
  });
  assert.equal(res.statusCode, 404);
});

test("PATCH /:id: name over 200 chars returns 400", async () => {
  const app = await buildApp();
  const res = await app.inject({
    method: "PATCH", url: "/b-1",
    headers: JSON_HEADERS,
    payload: JSON.stringify({ name: "a".repeat(201) }),
  });
  assert.equal(res.statusCode, 400);
});

test("PATCH /:id: unauthenticated returns 401", async () => {
  const app = await buildApp();
  const res = await app.inject({
    method: "PATCH", url: "/b-1",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ name: "X" }),
  });
  assert.equal(res.statusCode, 401);
});

// ── DELETE /:id — delete bundle ───────────────────────────────────────────────

test("DELETE /:id: plain delete returns 204", async () => {
  // Not an unpacked bundle -> no extracted-media cleanup
  const app = await buildApp({
    prisma: {
      bundleFindFirst: async () => ({ isUnpackedArchive: false, sourceMediaId: null, items: [] }),
    },
  });

  const res = await app.inject({ method: "DELETE", url: "/b-1", headers: AUTH });
  assert.equal(res.statusCode, 204);
});

test("DELETE /:id: clears linkedBundleId on source media when sourceMediaId present", async () => {
  const cleared: string[] = [];
  const app = await buildApp({
    prisma: {
      bundleFindFirst: async () => ({ isUnpackedArchive: true, sourceMediaId: "archive-1", items: [] }),
      mediaUpdateMany: async (args) => {
        cleared.push((args as { where: { id: string } }).where.id);
      },
    },
  });

  await app.inject({ method: "DELETE", url: "/b-1", headers: AUTH });
  assert.ok(cleared.includes("archive-1"), "should clear linkedBundleId on the source media");
});

test("DELETE /:id: deletes extracted media not in any other bundle", async () => {
  const deleted: string[] = [];
  const app = await buildApp({
    prisma: {
      bundleFindFirst: async () => ({
        isUnpackedArchive: true,
        sourceMediaId: "archive-1",
        items: [{ mediaId: "m-a" }, { mediaId: "m-b" }],
      }),
      mediaUpdateMany: async () => {},
      // No items are still membered in other bundles
      bundleItemFindMany: async () => [],
    },
    mediaServices: {
      deleteMedia: async (_uid, mid) => { deleted.push(mid); },
    },
  });

  await app.inject({ method: "DELETE", url: "/b-1", headers: AUTH });
  assert.deepEqual(deleted.sort(), ["m-a", "m-b"]);
});

test("DELETE /:id: does not delete extracted media still in another bundle", async () => {
  const deleted: string[] = [];
  const app = await buildApp({
    prisma: {
      bundleFindFirst: async () => ({
        isUnpackedArchive: true,
        sourceMediaId: "archive-1",
        items: [{ mediaId: "m-a" }, { mediaId: "m-b" }],
      }),
      mediaUpdateMany: async () => {},
      // Both items are still in another bundle
      bundleItemFindMany: async () => [{ mediaId: "m-a" }, { mediaId: "m-b" }],
    },
    mediaServices: {
      deleteMedia: async (_uid, mid) => { deleted.push(mid); },
    },
  });

  await app.inject({ method: "DELETE", url: "/b-1", headers: AUTH });
  assert.deepEqual(deleted, [], "no items should be deleted when all still in another bundle");
});

test("DELETE /:id: only deletes orphaned extracted media", async () => {
  const deleted: string[] = [];
  const app = await buildApp({
    prisma: {
      bundleFindFirst: async () => ({
        isUnpackedArchive: true,
        sourceMediaId: "archive-1",
        items: [{ mediaId: "m-a" }, { mediaId: "m-b" }, { mediaId: "m-c" }],
      }),
      mediaUpdateMany: async () => {},
      // m-b is still in another bundle; m-a and m-c are orphaned
      bundleItemFindMany: async () => [{ mediaId: "m-b" }],
    },
    mediaServices: {
      deleteMedia: async (_uid, mid) => { deleted.push(mid); },
    },
  });

  await app.inject({ method: "DELETE", url: "/b-1", headers: AUTH });
  assert.deepEqual(deleted.sort(), ["m-a", "m-c"]);
});

test("DELETE /:id: unauthenticated returns 401", async () => {
  const app = await buildApp();
  const res = await app.inject({ method: "DELETE", url: "/b-1" });
  assert.equal(res.statusCode, 401);
});

// ── POST /:id/items — add items ───────────────────────────────────────────────

test("POST /:id/items: adds items and returns ok", async () => {
  const app = await buildApp({
    prisma: {
      bundleFindFirst: async () => ({ id: "b-1" }),
      mediaCount: async () => 2, // both IDs belong to user
      bundleItemFindFirst: async () => null, // empty bundle → startOrder = 0
      bundleItemCreateMany: async () => {},
      bundleUpdate: async () => ({}),
    },
  });

  const res = await app.inject({
    method: "POST", url: "/b-1/items",
    headers: JSON_HEADERS,
    payload: JSON.stringify({ mediaIds: ["m-1", "m-2"] }),
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().ok, true);
});

test("POST /:id/items: returns 404 when repo returns false", async () => {
  // Bundle not found → addItems returns false
  const app = await buildApp({
    prisma: { bundleFindFirst: async () => null },
  });

  const res = await app.inject({
    method: "POST", url: "/b-1/items",
    headers: JSON_HEADERS,
    payload: JSON.stringify({ mediaIds: ["m-1"] }),
  });

  assert.equal(res.statusCode, 404);
});

test("POST /:id/items: empty mediaIds array returns 400", async () => {
  const app = await buildApp();
  const res = await app.inject({
    method: "POST", url: "/b-1/items",
    headers: JSON_HEADERS,
    payload: JSON.stringify({ mediaIds: [] }),
  });
  assert.equal(res.statusCode, 400);
});

test("POST /:id/items: more than 100 items returns 400", async () => {
  const app = await buildApp();
  const res = await app.inject({
    method: "POST", url: "/b-1/items",
    headers: JSON_HEADERS,
    payload: JSON.stringify({ mediaIds: Array.from({ length: 101 }, (_, i) => `m-${i}`) }),
  });
  assert.equal(res.statusCode, 400);
});

test("POST /:id/items: unauthenticated returns 401", async () => {
  const app = await buildApp();
  const res = await app.inject({
    method: "POST", url: "/b-1/items",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ mediaIds: ["m-1"] }),
  });
  assert.equal(res.statusCode, 401);
});

// ── DELETE /:id/items/:mediaId — remove item ──────────────────────────────────

test("DELETE /:id/items/:mediaId: removes item and returns 204", async () => {
  const app = await buildApp({
    prisma: {
      bundleFindFirst: async () => ({ id: "b-1" }),
      bundleItemDeleteMany: async () => {},
      bundleUpdate: async () => ({}),
      // clearCoverMedia — bundleUpdateMany scoped to bundle
      bundleUpdateMany: async () => ({ count: 0 }),
    },
  });

  const res = await app.inject({ method: "DELETE", url: "/b-1/items/m-1", headers: AUTH });
  assert.equal(res.statusCode, 204);
});

test("DELETE /:id/items/:mediaId: returns 404 when bundle not found", async () => {
  const app = await buildApp({
    prisma: { bundleFindFirst: async () => null },
  });
  const res = await app.inject({ method: "DELETE", url: "/b-1/items/m-1", headers: AUTH });
  assert.equal(res.statusCode, 404);
});

test("DELETE /:id/items/:mediaId: unauthenticated returns 401", async () => {
  const app = await buildApp();
  const res = await app.inject({ method: "DELETE", url: "/b-1/items/m-1" });
  assert.equal(res.statusCode, 401);
});

// ── POST /:id/star — toggle star ──────────────────────────────────────────────

test("POST /:id/star: stars an unstarred bundle", async () => {
  const app = await buildApp({
    prisma: {
      bundleFindFirst: async () => ({ starred: false }),
      bundleUpdate: async () => ({}),
    },
  });

  const res = await app.inject({ method: "POST", url: "/b-1/star", headers: AUTH });

  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.starred, true);
});

test("POST /:id/star: unstars a starred bundle", async () => {
  const app = await buildApp({
    prisma: {
      bundleFindFirst: async () => ({ starred: true }),
      bundleUpdate: async () => ({}),
    },
  });

  const res = await app.inject({ method: "POST", url: "/b-1/star", headers: AUTH });

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().starred, false);
});

test("POST /:id/star: returns 404 when bundle not found", async () => {
  const app = await buildApp({ prisma: { bundleFindFirst: async () => null } });
  const res = await app.inject({ method: "POST", url: "/b-1/star", headers: AUTH });
  assert.equal(res.statusCode, 404);
});

test("POST /:id/star: unauthenticated returns 401", async () => {
  const app = await buildApp();
  const res = await app.inject({ method: "POST", url: "/b-1/star" });
  assert.equal(res.statusCode, 401);
});

// ── PUT /:id/items/order — reorder ────────────────────────────────────────────

test("PUT /:id/items/order: reorders items and returns ok", async () => {
  const app = await buildApp({
    prisma: {
      bundleFindFirst: async () => ({ id: "b-1" }),
      bundleItemUpdateMany: async () => ({}),
    },
  });

  const res = await app.inject({
    method: "PUT", url: "/b-1/items/order",
    headers: JSON_HEADERS,
    payload: JSON.stringify({ orderedIds: ["m-3", "m-1", "m-2"] }),
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().ok, true);
});

test("PUT /:id/items/order: returns 404 when bundle not found", async () => {
  const app = await buildApp({ prisma: { bundleFindFirst: async () => null } });
  const res = await app.inject({
    method: "PUT", url: "/b-1/items/order",
    headers: JSON_HEADERS,
    payload: JSON.stringify({ orderedIds: ["m-1"] }),
  });
  assert.equal(res.statusCode, 404);
});

test("PUT /:id/items/order: empty orderedIds returns 400", async () => {
  const app = await buildApp();
  const res = await app.inject({
    method: "PUT", url: "/b-1/items/order",
    headers: JSON_HEADERS,
    payload: JSON.stringify({ orderedIds: [] }),
  });
  assert.equal(res.statusCode, 400);
});

test("PUT /:id/items/order: unauthenticated returns 401", async () => {
  const app = await buildApp();
  const res = await app.inject({
    method: "PUT", url: "/b-1/items/order",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ orderedIds: ["m-1"] }),
  });
  assert.equal(res.statusCode, 401);
});

// ── GET /:id/export — streaming export ────────────────────────────────────────

// The success path uses reply.hijack() + raw socket streaming which is not
// captured by app.inject(). Only the pre-stream 404 path is tested here.
test("GET /:id/export: returns 404 when bundle not found", async () => {
  const app = await buildApp({ prisma: { bundleFindFirst: async () => null } });
  const res = await app.inject({ method: "GET", url: "/b-1/export", headers: AUTH });
  assert.equal(res.statusCode, 404);
});

test("GET /:id/export: unauthenticated returns 401", async () => {
  const app = await buildApp();
  const res = await app.inject({ method: "GET", url: "/b-1/export" });
  assert.equal(res.statusCode, 401);
});
