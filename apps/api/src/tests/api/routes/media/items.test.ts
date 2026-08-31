import test from "node:test";
import assert from "node:assert/strict";
import { mediaItemsRoutes } from "@/routes/media/items.js";
import { buildRouteApp, AUTH, JSON_HEADERS, ID } from "../helpers/buildRouteApp.js";

const build = (services = {}) => buildRouteApp(mediaItemsRoutes, { services });

// ── DELETE /:id ────────────────────────────────────────────────────────────────

test("DELETE /:id: found media returns 200 with result", async () => {
  const app = await build({ actionsService: { deleteMedia: async () => ({ id: ID, deleted: true }) } });

  const res = await app.inject({ method: "DELETE", url: `/${ID}`, headers: AUTH });
  assert.equal(res.statusCode, 200);
  assert.ok(res.json().deleted);
});

test("DELETE /:id: not found returns 404", async () => {
  const app = await build({ actionsService: { deleteMedia: async () => null } });
  const res = await app.inject({ method: "DELETE", url: `/${ID}`, headers: AUTH });
  assert.equal(res.statusCode, 404);
});

test("DELETE /:id: unauthenticated returns 401", async () => {
  const app = await build();
  const res = await app.inject({ method: "DELETE", url: `/${ID}` });
  assert.equal(res.statusCode, 401);
});

// ── PATCH /:id ─────────────────────────────────────────────────────────────────

test("PATCH /:id: title update returns 200 with updated media", async () => {
  const updated = { id: ID, title: "New Title" };
  const app = await build({ actionsService: { updateMediaMetadata: async () => updated } });

  const res = await app.inject({
    method: "PATCH", url: `/${ID}`,
    headers: JSON_HEADERS,
    payload: JSON.stringify({ title: "New Title" }),
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().media.title, "New Title");
});

test("PATCH /:id: not found returns 404", async () => {
  const app = await build({ actionsService: { updateMediaMetadata: async () => null } });
  const res = await app.inject({
    method: "PATCH", url: `/${ID}`,
    headers: JSON_HEADERS,
    payload: JSON.stringify({ title: "T" }),
  });
  assert.equal(res.statusCode, 404);
});

test("PATCH /:id: unauthenticated returns 401", async () => {
  const app = await build();
  const res = await app.inject({
    method: "PATCH", url: `/${ID}`,
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ title: "T" }),
  });
  assert.equal(res.statusCode, 401);
});

// ── POST /:id/star ─────────────────────────────────────────────────────────────

test("POST /:id/star: returns the new starred state", async () => {
  const app = await build({ actionsService: { toggleStar: async () => true } });
  const res = await app.inject({ method: "POST", url: `/${ID}/star`, headers: AUTH });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true, starred: true });
});

test("POST /:id/star: an item the user doesn't own returns 404", async () => {
  const app = await build({ actionsService: { toggleStar: async () => null } });
  const res = await app.inject({ method: "POST", url: `/${ID}/star`, headers: AUTH });
  assert.equal(res.statusCode, 404);
});

// ── GET /:id — media detail ────────────────────────────────────────────────────

const detailFor = (over: Record<string, unknown> = {}) => ({
  media: { id: ID, title: "photo.jpg", mimeType: "image/jpeg", sourcePath: null, storageKey: "orig/key", ...over },
  document: null,
  metadata: null,
  permissions: { canEdit: true, canDelete: true, canDownload: true, canOcr: true },
});

test("GET /:id: returns media detail", async () => {
  const app = await build({ readService: { getMediaDetail: async () => detailFor() } });
  const res = await app.inject({ method: "GET", url: `/${ID}`, headers: AUTH });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().media.id, ID);
});

test("GET /:id: not found returns 404", async () => {
  const app = await build({ readService: { getMediaDetail: async () => null } });
  const res = await app.inject({ method: "GET", url: `/${ID}`, headers: AUTH });
  assert.equal(res.statusCode, 404);
});

test("GET /:id: unauthenticated returns 401", async () => {
  const app = await build();
  const res = await app.inject({ method: "GET", url: `/${ID}` });
  assert.equal(res.statusCode, 401);
});

// A PENDING thumbnail must go through the feeder, not changePriority: under the
// pull model most PENDING rows have no job in Redis, so reprioritising one that
// was never dispatched is a silent no-op.
test("GET /:id: a PENDING thumbnail is promoted through the feeder when one exists", async () => {
  let promoted: string[] | null = null;
  let fellBack = false;
  const app = await buildRouteApp(mediaItemsRoutes, {
    services: {
      readService: { getMediaDetail: async () => detailFor({ thumbState: "PENDING" }) },
      actionsService: { prioritizeThumbnail: async () => { fellBack = true; return { ok: true }; } },
    },
    decorate: {
      derivativeFeeder: {
        promoteThumbnails: async (_u: string, ids: string[]) => { promoted = ids; return { queued: 1, reordered: 0 }; },
      },
    },
  });

  const res = await app.inject({ method: "GET", url: `/${ID}`, headers: AUTH });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(promoted, [ID]);
  assert.equal(fellBack, false);
});

// No feeder means DERIVATIVE_FEED_ENABLED=false; the queue-level reorder is all
// that is left, and it must still be attempted.
test("GET /:id: falls back to prioritizeThumbnail when no feeder is wired", async () => {
  let fellBackWith: string | null = null;
  const app = await build({
    readService: { getMediaDetail: async () => detailFor({ thumbState: "PENDING" }) },
    actionsService: { prioritizeThumbnail: async (id: string) => { fellBackWith = id; return { ok: true }; } },
  });

  const res = await app.inject({ method: "GET", url: `/${ID}`, headers: AUTH });

  assert.equal(res.statusCode, 200);
  assert.equal(fellBackWith, ID);
});

test("GET /:id: a READY thumbnail is not promoted", async () => {
  let promoted = false;
  const app = await build({
    readService: { getMediaDetail: async () => detailFor({ thumbState: "READY" }) },
    actionsService: { prioritizeThumbnail: async () => { promoted = true; return { ok: true }; } },
  });

  await app.inject({ method: "GET", url: `/${ID}`, headers: AUTH });
  assert.equal(promoted, false);
});

test("GET /:id: localPath is built from STORAGE_FS_PATH for a managed row", async () => {
  const app = await build({ readService: { getMediaDetail: async () => detailFor() } });
  const res = await app.inject({ method: "GET", url: `/${ID}`, headers: AUTH });
  assert.match(res.json().localPath, /orig[/\\]key$/);
});

// storageKey is server-written; defense in depth for the reveal spawn below.
test("GET /:id: a storageKey escaping STORAGE_FS_PATH yields no localPath", async () => {
  const app = await build({ readService: { getMediaDetail: async () => detailFor({ storageKey: "../../etc/passwd" }) } });
  const res = await app.inject({ method: "GET", url: `/${ID}`, headers: AUTH });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().localPath, "");
});

test("GET /:id: localPath is the sourcePath for an in-place row", async () => {
  const app = await build({
    readService: { getMediaDetail: async () => detailFor({ sourcePath: "E:\\photos\\a.jpg", storageKey: null }) },
  });
  const res = await app.inject({ method: "GET", url: `/${ID}`, headers: AUTH });
  assert.equal(res.json().localPath, "E:\\photos\\a.jpg");
});

// ── POST /:id/reveal ───────────────────────────────────────────────────────────

test("POST /:id/reveal: refused when the server can't reach a desktop", async () => {
  const app = await build();
  const res = await app.inject({ method: "POST", url: `/${ID}/reveal`, headers: AUTH });
  assert.equal(res.statusCode, 403);
  assert.match(res.json().message, /disabled on this server/i);
});

test("POST /:id/reveal: an in-place source outside the allow-list is refused", async () => {
  const app = await buildRouteApp(mediaItemsRoutes, {
    config: { LOCAL_EXPLORER: true },
    services: {
      readService: { getStorageKey: async () => ({ sourcePath: "E:\\elsewhere\\a.jpg", storageKey: null }) },
    },
    preferences: { indexAllowedRoots: ["E:\\photos"] },
  });
  const res = await app.inject({ method: "POST", url: `/${ID}/reveal`, headers: AUTH });
  assert.equal(res.statusCode, 403);
  assert.match(res.json().message, /no longer within an allowed root/i);
});

test("POST /:id/reveal: a storageKey escaping STORAGE_FS_PATH is refused before any spawn", async () => {
  const app = await buildRouteApp(mediaItemsRoutes, {
    config: { LOCAL_EXPLORER: true },
    services: {
      readService: { getStorageKey: async () => ({ sourcePath: null, storageKey: "../../../windows/system32" }) },
    },
  });
  const res = await app.inject({ method: "POST", url: `/${ID}/reveal`, headers: AUTH });
  assert.equal(res.statusCode, 403);
  assert.match(res.json().message, /outside Vault's storage folder/i);
});

test("POST /:id/reveal: an unknown item returns 404", async () => {
  const app = await buildRouteApp(mediaItemsRoutes, {
    config: { LOCAL_EXPLORER: true },
    services: { readService: { getStorageKey: async () => null } },
  });
  const res = await app.inject({ method: "POST", url: `/${ID}/reveal`, headers: AUTH });
  assert.equal(res.statusCode, 404);
});

test("POST /:id/reveal: unauthenticated returns 401", async () => {
  const app = await build();
  const res = await app.inject({ method: "POST", url: `/${ID}/reveal` });
  assert.equal(res.statusCode, 401);
});
