import test from "node:test";
import assert from "node:assert/strict";
import { mediaArchiveRoutes } from "@/routes/media/archives.js";
import { buildRouteApp, AUTH, JSON_HEADERS, ID } from "../helpers/buildRouteApp.js";

const build = (services = {}) => buildRouteApp(mediaArchiveRoutes, { services });

// ── POST /unpack-new ───────────────────────────────────────────────────────────
//
// Which of the ids are archives is archiveService's decision (see
// archiveService.test.ts). What the route owns is the preference gate and the
// allow-list snapshot it hands over.

test("POST /unpack-new: enabled, it delegates with the ids and the allow-list snapshot", async () => {
  let seen: { ids: string[]; roots: string[] } | undefined;
  const app = await buildRouteApp(mediaArchiveRoutes, {
    services: {
      archiveService: {
        enqueueUnpackForArchives: async (_u: string, ids: string[], roots: string[]) => { seen = { ids, roots }; return { queued: 1 }; },
      },
    },
    preferences: { autoUnpackArchives: true, indexAllowedRoots: ["/data"] },
  });

  const res = await app.inject({
    method: "POST", url: "/unpack-new",
    headers: JSON_HEADERS,
    payload: JSON.stringify({ ids: [ID] }),
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true, count: 1, queued: 1 });
  assert.deepEqual(seen?.ids, [ID]);
  assert.deepEqual(seen?.roots, ["/data"]);
});

// An enqueue the service caught and logged must not be reported as success —
// the row exists, but nothing will ever unpack it.
test("POST /unpack-new: reports what was queued, not what was submitted", async () => {
  const app = await buildRouteApp(mediaArchiveRoutes, {
    services: {
      archiveService: { enqueueUnpackForArchives: async () => ({ queued: 0 }) },
    },
    preferences: { autoUnpackArchives: true },
  });

  const res = await app.inject({
    method: "POST", url: "/unpack-new",
    headers: JSON_HEADERS,
    payload: JSON.stringify({ ids: [ID, "00000000-0000-0000-0000-000000000002"] }),
  });

  assert.deepEqual(res.json(), { ok: true, count: 2, queued: 0 });
});

test("POST /unpack-new: the preference off skips the service entirely", async () => {
  let called = false;
  const app = await build({
    archiveService: { enqueueUnpackForArchives: async () => { called = true; return { queued: 0 }; } },
  });

  const res = await app.inject({
    method: "POST", url: "/unpack-new",
    headers: JSON_HEADERS,
    payload: JSON.stringify({ ids: [ID] }),
  });

  assert.equal(res.statusCode, 200);
  assert.equal(called, false);
});

// An explicit body flag beats the stored preference — the Add files page sends
// what the user chose for this batch.
test("POST /unpack-new: an explicit autoUnpack:false overrides the preference", async () => {
  let called = false;
  const app = await buildRouteApp(mediaArchiveRoutes, {
    services: {
      archiveService: { enqueueUnpackForArchives: async () => { called = true; return { queued: 0 }; } },
    },
    preferences: { autoUnpackArchives: true },
  });

  const res = await app.inject({
    method: "POST", url: "/unpack-new",
    headers: JSON_HEADERS,
    payload: JSON.stringify({ ids: [ID], autoUnpack: false }),
  });

  assert.equal(res.statusCode, 200);
  assert.equal(called, false);
});

test("POST /unpack-new: unauthenticated returns 401", async () => {
  const app = await build();
  const res = await app.inject({
    method: "POST", url: "/unpack-new",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ ids: [ID] }),
  });
  assert.equal(res.statusCode, 401);
});

// ── POST /:id/unpack ───────────────────────────────────────────────────────────

test("POST /:id/unpack: media not found returns 404", async () => {
  const app = await build({ archiveService: { unpackArchive: async () => null } });
  const res = await app.inject({ method: "POST", url: `/${ID}/unpack`, headers: AUTH });
  assert.equal(res.statusCode, 404);
});

test("POST /:id/unpack: non-archive MIME type returns 400", async () => {
  const app = await build({ archiveService: { unpackArchive: async () => "not-archive" } });
  const res = await app.inject({ method: "POST", url: `/${ID}/unpack`, headers: AUTH });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().message, /not a recognised archive/i);
});

test("POST /:id/unpack: already-linked archive returns 409", async () => {
  const app = await build({ archiveService: { unpackArchive: async () => "already-linked" } });
  const res = await app.inject({ method: "POST", url: `/${ID}/unpack`, headers: AUTH });
  assert.equal(res.statusCode, 409);
  assert.match(res.json().error, /already linked/i);
});

test("POST /:id/unpack: success returns bundleId", async () => {
  const app = await build({ archiveService: { unpackArchive: async () => ({ bundleId: "b-1" }) } });
  const res = await app.inject({ method: "POST", url: `/${ID}/unpack`, headers: AUTH });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().bundleId, "b-1");
});

test("POST /:id/unpack: unauthenticated returns 401", async () => {
  const app = await build();
  const res = await app.inject({ method: "POST", url: `/${ID}/unpack` });
  assert.equal(res.statusCode, 401);
});
