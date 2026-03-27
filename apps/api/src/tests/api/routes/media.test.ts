import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import sensible from "@fastify/sensible";
import { mediaRoutes } from "@/routes/media.js";

// ── Mock helpers ───────────────────────────────────────────────────────────────

interface BuildOpts {
  uploadService?: {
    initUpload?: (_u: string, _d: unknown) => Promise<unknown>;
    initBatchUploads?: (_u: string, _d: unknown) => Promise<unknown>;
    finalizeBatch?: (_u: string, _ids: string[]) => Promise<unknown>;
  };
  queryService?: {
    listMedia?: (_u: string, _opts: unknown) => Promise<unknown>;
  };
  readService?: {
    getMediaDetail?: (_u: string, _id: string) => Promise<unknown>;
    getThumbnail?: (_id: string) => Promise<{ body?: Buffer; etag?: string } | null>;
    getTextChunk?: (_u: string, _id: string, _offset: number, _limit: number) => Promise<unknown>;
  };
  actionsService?: {
    deleteMedia?: (_u: string, _id: string) => Promise<unknown>;
    updateMediaMetadata?: (_u: string, _id: string, _d: unknown) => Promise<unknown>;
    getBulkDownloadItems?: (_u: string, _ids: string[]) => Promise<unknown[]>;
    streamBulkArchive?: (_items: unknown, _raw: unknown, _log: unknown) => Promise<void>;
    getDownloadUrl?: (_u: string, _id: string) => Promise<string | null>;
    enqueueTextExtraction?: (_u: string, _id: string, _opts: unknown) => Promise<unknown>;
    cancelTextExtraction?: (_u: string, _id: string) => Promise<unknown>;
    unpackArchive?: (_u: string, _id: string) => Promise<unknown>;
    regenerateThumbnail?: (_u: string, _id: string) => Promise<unknown>;
  };
  prisma?: {
    userFindUnique?: (_a: unknown) => Promise<unknown>;
    mediaFindMany?: (_a: unknown) => Promise<unknown[]>;
    mediaFindFirst?: (_a: unknown) => Promise<unknown>;
  };
  preferencesService?: {
    getPreferences?: (_userId: string) => Promise<{ autoTagOnUpload: boolean; autoUnpackArchives: boolean }>;
  };
}

function makeMediaServices({
  uploadService: us = {},
  queryService: qs = {},
  readService: rs = {},
  actionsService: as_svc = {},
}: Pick<BuildOpts, "uploadService" | "queryService" | "readService" | "actionsService"> = {}) {
  return {
    uploadService: {
      initUpload: us.initUpload ?? (async () => ({ id: "m-1", uploadUrl: "https://s3.test/" })),
      initBatchUploads: us.initBatchUploads ?? (async () => ({ items: [] })),
      finalizeBatch: us.finalizeBatch ?? (async () => ({ processed: [] })),
    },
    queryService: {
      listMedia: qs.listMedia ?? (async () => ({ items: [], nextCursor: null })),
    },
    readService: {
      getMediaDetail: rs.getMediaDetail ?? (async () => null),
      getThumbnail: rs.getThumbnail ?? (async () => null),
      getTextChunk: rs.getTextChunk ?? (async () => null),
    },
    actionsService: {
      deleteMedia: as_svc.deleteMedia ?? (async () => null),
      updateMediaMetadata: as_svc.updateMediaMetadata ?? (async () => null),
      getBulkDownloadItems: as_svc.getBulkDownloadItems ?? (async () => []),
      streamBulkArchive: as_svc.streamBulkArchive ?? (async () => {}),
      getDownloadUrl: as_svc.getDownloadUrl ?? (async () => null),
      enqueueTextExtraction: as_svc.enqueueTextExtraction ?? (async () => null),
      cancelTextExtraction: as_svc.cancelTextExtraction ?? (async () => null),
      unpackArchive: as_svc.unpackArchive ?? (async () => null),
      regenerateThumbnail: as_svc.regenerateThumbnail ?? (async () => null),
    },
  };
}

function makePrisma(opts: BuildOpts["prisma"] = {}) {
  const {
    userFindUnique = async () => null,
    mediaFindMany = async () => [],
    mediaFindFirst = async () => null,
  } = opts ?? {};
  return {
    user: { findUnique: userFindUnique },
    media: { findMany: mediaFindMany, findFirst: mediaFindFirst },
  };
}

async function buildApp(opts: BuildOpts = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(sensible);

  (app as any).decorate("jwt", {
    verifyAccess: () => ({ sub: "user-1" }),
    signAccess: () => "",
    signRefresh: () => "",
    verifyRefresh: () => ({ sub: "user-1" }),
  });

  (app as any).decorate("prisma", makePrisma(opts.prisma));

  (app as any).decorate("mediaServices", makeMediaServices(opts));

  (app as any).decorate("preferencesService", {
    getPreferences: opts.preferencesService?.getPreferences
      ?? (async () => ({ autoTagOnUpload: true, autoUnpackArchives: false })),
  });

  (app as any).decorate("config", { REDIS_URL: "redis://localhost:6379" });
  await app.register(mediaRoutes);
  appsToClose.push(app);
  return app;
}

const appsToClose: FastifyInstance[] = [];
test.after(async () => {
  await Promise.all(appsToClose.map(app => app.close()));
});

const AUTH = { authorization: "Bearer test-token" };
const JSON_HEADERS = { ...AUTH, "content-type": "application/json" };
/** Any valid UUID — used as a stand-in media/param ID throughout. */
const ID = "00000000-0000-0000-0000-000000000001";

// ── POST / — init upload ───────────────────────────────────────────────────────

test("POST /: valid body returns upload result", async () => {
  const app = await buildApp({
    uploadService: {
      initUpload: async () => ({ id: "m-new", uploadUrl: "https://s3.test/m-new" }),
    },
  });

  const res = await app.inject({
    method: "POST", url: "/",
    headers: JSON_HEADERS,
    payload: JSON.stringify({
      filename: "file.pdf", mimeType: "application/pdf", sizeBytes: 1024, title: "My Doc", tags: [],
    }),
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().id, "m-new");
  assert.ok(res.json().uploadUrl);
});

test("POST /: unauthenticated returns 401", async () => {
  const app = await buildApp();
  const res = await app.inject({
    method: "POST", url: "/",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ filename: "f.pdf", mimeType: "application/pdf", sizeBytes: 1024, title: "T" }),
  });
  assert.equal(res.statusCode, 401);
});

// ── POST /batch-init ───────────────────────────────────────────────────────────

test("POST /batch-init: valid items returns batch result", async () => {
  const app = await buildApp({
    uploadService: {
      initBatchUploads: async () => ({
        items: [{ id: "m-1", uploadUrl: "https://s3.test/m-1" }],
      }),
    },
  });

  const res = await app.inject({
    method: "POST", url: "/batch-init",
    headers: JSON_HEADERS,
    payload: JSON.stringify({
      items: [{ filename: "a.pdf", mimeType: "application/pdf", sizeBytes: 1024 }],
    }),
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().items.length, 1);
});

test("POST /batch-init: unauthenticated returns 401", async () => {
  const app = await buildApp();
  const res = await app.inject({
    method: "POST", url: "/batch-init",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ items: [{ filename: "a.pdf", mimeType: "application/pdf", sizeBytes: 1024 }] }),
  });
  assert.equal(res.statusCode, 401);
});

// ── POST /batch-finalize ───────────────────────────────────────────────────────

test("POST /batch-finalize: valid ids calls finalizeBatch and returns result", async () => {
  let capturedIds: string[] | undefined;
  const app = await buildApp({
    uploadService: {
      finalizeBatch: async (_u, ids) => { capturedIds = ids; return { processed: ids }; },
    },
  });

  const res = await app.inject({
    method: "POST", url: "/batch-finalize",
    headers: JSON_HEADERS,
    payload: JSON.stringify({ ids: [ID] }),
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(capturedIds, [ID]);
});

test("POST /batch-finalize: unauthenticated returns 401", async () => {
  const app = await buildApp();
  const res = await app.inject({
    method: "POST", url: "/batch-finalize",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ ids: [ID] }),
  });
  assert.equal(res.statusCode, 401);
});

// ── POST /:id/finalize ─────────────────────────────────────────────────────────

test("POST /:id/finalize: valid UUID calls finalizeBatch", async () => {
  const app = await buildApp({
    uploadService: {
      finalizeBatch: async () => ({ processed: [{ id: ID, status: "READY" }] }),
    },
  });

  const res = await app.inject({
    method: "POST", url: `/${ID}/finalize`,
    headers: AUTH,
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().processed[0].id, ID);
});

test("POST /:id/finalize: unauthenticated returns 401", async () => {
  const app = await buildApp();
  const res = await app.inject({ method: "POST", url: `/${ID}/finalize` });
  assert.equal(res.statusCode, 401);
});

// ── GET / — list media ─────────────────────────────────────────────────────────

test("GET /: returns media list from queryService", async () => {
  const app = await buildApp({
    queryService: {
      listMedia: async () => ({ items: [{ id: "m-1", title: "photo.jpg" }], nextCursor: null }),
    },
  });

  const res = await app.inject({ method: "GET", url: "/", headers: AUTH });

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().items.length, 1);
  assert.equal(res.json().items[0].id, "m-1");
});

test("GET /: ?tag and ?tags together returns 400", async () => {
  const app = await buildApp();
  const res = await app.inject({ method: "GET", url: "/?tag=foo&tags=bar", headers: AUTH });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().message, /either.*tag.*or.*tags/i);
});

test("GET /: empty ?tags= value returns 400", async () => {
  const app = await buildApp();
  const res = await app.inject({ method: "GET", url: "/?tags=", headers: AUTH });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().message, /at least one tag/i);
});

test("GET /: unauthenticated returns 401", async () => {
  const app = await buildApp();
  const res = await app.inject({ method: "GET", url: "/" });
  assert.equal(res.statusCode, 401);
});

// ── GET /events — SSE stream ───────────────────────────────────────────────────

// The success path uses reply.hijack() + raw socket streaming and cannot be
// captured by app.inject(). Only the auth guard is tested here.
test("GET /events: unauthenticated returns 401", async () => {
  const app = await buildApp();
  const res = await app.inject({ method: "GET", url: "/events" });
  assert.equal(res.statusCode, 401);
});

// ── DELETE /:id ────────────────────────────────────────────────────────────────

test("DELETE /:id: found media returns 200 with result", async () => {
  const app = await buildApp({
    actionsService: {
      deleteMedia: async () => ({ id: ID, deleted: true }),
    },
  });

  const res = await app.inject({ method: "DELETE", url: `/${ID}`, headers: AUTH });
  assert.equal(res.statusCode, 200);
  assert.ok(res.json().deleted);
});

test("DELETE /:id: not found returns 404", async () => {
  const app = await buildApp({ actionsService: { deleteMedia: async () => null } });
  const res = await app.inject({ method: "DELETE", url: `/${ID}`, headers: AUTH });
  assert.equal(res.statusCode, 404);
});

test("DELETE /:id: unauthenticated returns 401", async () => {
  const app = await buildApp();
  const res = await app.inject({ method: "DELETE", url: `/${ID}` });
  assert.equal(res.statusCode, 401);
});

// ── PATCH /:id ─────────────────────────────────────────────────────────────────

test("PATCH /:id: title update returns 200 with updated media", async () => {
  const updated = { id: ID, title: "New Title" };
  const app = await buildApp({
    actionsService: { updateMediaMetadata: async () => updated },
  });

  const res = await app.inject({
    method: "PATCH", url: `/${ID}`,
    headers: JSON_HEADERS,
    payload: JSON.stringify({ title: "New Title" }),
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().media.title, "New Title");
});

test("PATCH /:id: not found returns 404", async () => {
  const app = await buildApp({ actionsService: { updateMediaMetadata: async () => null } });
  const res = await app.inject({
    method: "PATCH", url: `/${ID}`,
    headers: JSON_HEADERS,
    payload: JSON.stringify({ title: "T" }),
  });
  assert.equal(res.statusCode, 404);
});

test("PATCH /:id: unauthenticated returns 401", async () => {
  const app = await buildApp();
  const res = await app.inject({
    method: "PATCH", url: `/${ID}`,
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ title: "T" }),
  });
  assert.equal(res.statusCode, 401);
});

// ── POST /bulk-download ────────────────────────────────────────────────────────

// The success path uses reply.hijack() for streaming. Only pre-stream paths
// are testable via app.inject().
test("POST /bulk-download: no items found returns 404", async () => {
  const app = await buildApp({ actionsService: { getBulkDownloadItems: async () => [] } });
  const res = await app.inject({
    method: "POST", url: "/bulk-download",
    headers: JSON_HEADERS,
    payload: JSON.stringify({ ids: [ID] }),
  });
  assert.equal(res.statusCode, 404);
});

test("POST /bulk-download: unauthenticated returns 401", async () => {
  const app = await buildApp();
  const res = await app.inject({
    method: "POST", url: "/bulk-download",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ ids: [ID] }),
  });
  assert.equal(res.statusCode, 401);
});

// ── GET /:id/download ──────────────────────────────────────────────────────────

test("GET /:id/download: returns presigned URL", async () => {
  const app = await buildApp({
    actionsService: { getDownloadUrl: async () => "https://s3.test/signed-url" },
  });
  const res = await app.inject({ method: "GET", url: `/${ID}/download`, headers: AUTH });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /signed-url/);
});

test("GET /:id/download: not found returns 404", async () => {
  const app = await buildApp({ actionsService: { getDownloadUrl: async () => null } });
  const res = await app.inject({ method: "GET", url: `/${ID}/download`, headers: AUTH });
  assert.equal(res.statusCode, 404);
});

test("GET /:id/download: unauthenticated returns 401", async () => {
  const app = await buildApp();
  const res = await app.inject({ method: "GET", url: `/${ID}/download` });
  assert.equal(res.statusCode, 401);
});

// ── GET /:id/text ──────────────────────────────────────────────────────────────

test("GET /:id/text: returns text chunk with default offset/limit", async () => {
  const app = await buildApp({
    readService: {
      getTextChunk: async () => ({ text: "hello world", offset: 0, total: 11 }),
    },
  });
  const res = await app.inject({ method: "GET", url: `/${ID}/text`, headers: AUTH });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().text, "hello world");
});

test("GET /:id/text: not found returns 404", async () => {
  const app = await buildApp({ readService: { getTextChunk: async () => null } });
  const res = await app.inject({ method: "GET", url: `/${ID}/text`, headers: AUTH });
  assert.equal(res.statusCode, 404);
});

test("GET /:id/text: unauthenticated returns 401", async () => {
  const app = await buildApp();
  const res = await app.inject({ method: "GET", url: `/${ID}/text` });
  assert.equal(res.statusCode, 401);
});

// ── POST /:id/text — enqueue text extraction ───────────────────────────────────

test("POST /:id/text: enqueues extraction and returns result", async () => {
  const app = await buildApp({
    actionsService: {
      enqueueTextExtraction: async () => ({ jobId: "j-1", status: "PENDING" }),
    },
  });
  const res = await app.inject({
    method: "POST", url: `/${ID}/text`,
    headers: JSON_HEADERS,
    payload: JSON.stringify({}),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().jobId, "j-1");
});

test("POST /:id/text: not found returns 404", async () => {
  const app = await buildApp({ actionsService: { enqueueTextExtraction: async () => null } });
  const res = await app.inject({
    method: "POST", url: `/${ID}/text`,
    headers: JSON_HEADERS,
    payload: JSON.stringify({}),
  });
  assert.equal(res.statusCode, 404);
});

test("POST /:id/text: unauthenticated returns 401", async () => {
  const app = await buildApp();
  const res = await app.inject({ method: "POST", url: `/${ID}/text` });
  assert.equal(res.statusCode, 401);
});

// ── POST /:id/text/cancel ──────────────────────────────────────────────────────

test("POST /:id/text/cancel: cancels extraction and returns result", async () => {
  const app = await buildApp({
    actionsService: { cancelTextExtraction: async () => ({ ok: true }) },
  });
  const res = await app.inject({ method: "POST", url: `/${ID}/text/cancel`, headers: AUTH });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().ok, true);
});

test("POST /:id/text/cancel: not found returns 404", async () => {
  const app = await buildApp({ actionsService: { cancelTextExtraction: async () => null } });
  const res = await app.inject({ method: "POST", url: `/${ID}/text/cancel`, headers: AUTH });
  assert.equal(res.statusCode, 404);
});

test("POST /:id/text/cancel: unauthenticated returns 401", async () => {
  const app = await buildApp();
  const res = await app.inject({ method: "POST", url: `/${ID}/text/cancel` });
  assert.equal(res.statusCode, 401);
});

// ── POST /:id/unpack ───────────────────────────────────────────────────────────

test("POST /:id/unpack: media not found returns 404", async () => {
  const app = await buildApp({ prisma: { mediaFindFirst: async () => null } });
  const res = await app.inject({ method: "POST", url: `/${ID}/unpack`, headers: AUTH });
  assert.equal(res.statusCode, 404);
});

test("POST /:id/unpack: non-archive MIME type returns 400", async () => {
  const app = await buildApp({
    actionsService: { unpackArchive: async () => "not-archive" },
  });
  const res = await app.inject({ method: "POST", url: `/${ID}/unpack`, headers: AUTH });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().message, /not a recognised archive/i);
});

test("POST /:id/unpack: already-linked archive returns 409", async () => {
  const app = await buildApp({
    prisma: { mediaFindFirst: async () => ({ mimeType: "application/zip" }) },
    actionsService: { unpackArchive: async () => "already-linked" },
  });
  const res = await app.inject({ method: "POST", url: `/${ID}/unpack`, headers: AUTH });
  assert.equal(res.statusCode, 409);
  assert.match(res.json().error, /already linked/i);
});

test("POST /:id/unpack: success returns bundleId", async () => {
  const app = await buildApp({
    prisma: { mediaFindFirst: async () => ({ mimeType: "application/zip" }) },
    actionsService: { unpackArchive: async () => ({ bundleId: "b-1" }) },
  });
  const res = await app.inject({ method: "POST", url: `/${ID}/unpack`, headers: AUTH });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().bundleId, "b-1");
});

test("POST /:id/unpack: unauthenticated returns 401", async () => {
  const app = await buildApp();
  const res = await app.inject({ method: "POST", url: `/${ID}/unpack` });
  assert.equal(res.statusCode, 401);
});

// ── GET /:id — media detail ────────────────────────────────────────────────────

test("GET /:id: returns media detail", async () => {
  const detail = { id: ID, title: "photo.jpg", mimeType: "image/jpeg" };
  const app = await buildApp({ readService: { getMediaDetail: async () => detail } });
  const res = await app.inject({ method: "GET", url: `/${ID}`, headers: AUTH });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().id, ID);
});

test("GET /:id: not found returns 404", async () => {
  const app = await buildApp({ readService: { getMediaDetail: async () => null } });
  const res = await app.inject({ method: "GET", url: `/${ID}`, headers: AUTH });
  assert.equal(res.statusCode, 404);
});

test("GET /:id: unauthenticated returns 401", async () => {
  const app = await buildApp();
  const res = await app.inject({ method: "GET", url: `/${ID}` });
  assert.equal(res.statusCode, 401);
});

// ── POST /:id/thumbnail/regenerate ────────────────────────────────────────────

test("POST /:id/thumbnail/regenerate: returns result", async () => {
  const app = await buildApp({
    actionsService: { regenerateThumbnail: async () => ({ jobId: "t-1" }) },
  });
  const res = await app.inject({ method: "POST", url: `/${ID}/thumbnail/regenerate`, headers: AUTH });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().jobId, "t-1");
});

test("POST /:id/thumbnail/regenerate: not found returns 404", async () => {
  const app = await buildApp({ actionsService: { regenerateThumbnail: async () => null } });
  const res = await app.inject({ method: "POST", url: `/${ID}/thumbnail/regenerate`, headers: AUTH });
  assert.equal(res.statusCode, 404);
});

test("POST /:id/thumbnail/regenerate: unauthenticated returns 401", async () => {
  const app = await buildApp();
  const res = await app.inject({ method: "POST", url: `/${ID}/thumbnail/regenerate` });
  assert.equal(res.statusCode, 401);
});

// ── GET /:id/thumbnail ────────────────────────────────────────────────────────

test("GET /:id/thumbnail: returns webp content-type when thumbnail exists", async () => {
  const fakeWebp = Buffer.from([0x52, 0x49, 0x46, 0x46]); // "RIFF" — start of a WebP file
  const app = await buildApp({
    readService: { getThumbnail: async () => ({ body: fakeWebp, etag: "abc123" }) },
  });
  const res = await app.inject({ method: "GET", url: `/${ID}/thumbnail`, headers: AUTH });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "image/webp");
});

test("GET /:id/thumbnail: returns fallback webp when thumbnail is absent", async () => {
  const app = await buildApp({ readService: { getThumbnail: async () => null } });
  const res = await app.inject({ method: "GET", url: `/${ID}/thumbnail`, headers: AUTH });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "image/webp");
});

test("GET /:id/thumbnail: invalid UUID returns fallback webp instead of 400", async () => {
  const app = await buildApp();
  const res = await app.inject({ method: "GET", url: "/not-a-uuid/thumbnail", headers: AUTH });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "image/webp");
});

test("GET /:id/thumbnail: unauthenticated returns 401", async () => {
  const app = await buildApp();
  const res = await app.inject({ method: "GET", url: `/${ID}/thumbnail` });
  assert.equal(res.statusCode, 401);
});
