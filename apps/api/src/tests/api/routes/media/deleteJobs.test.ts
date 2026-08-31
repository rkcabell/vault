import test from "node:test";
import assert from "node:assert/strict";
import { mediaDeleteJobRoutes } from "@/routes/media/deleteJobs.js";
import { buildRouteApp, AUTH, JSON_HEADERS, ID } from "../helpers/buildRouteApp.js";

const build = (services = {}) => buildRouteApp(mediaDeleteJobRoutes, { services });

// ── DELETE / — bulk delete ─────────────────────────────────────────────────────

test("DELETE /: hand-picked ids enqueue an id-based job and return 202", async () => {
  let seen: { ids?: string[] } | null = null;
  const app = await build({
    deleteService: {
      startDelete: async (_u: string, input: { ids?: string[] }) => { seen = input; return { jobId: "job-1" }; },
    },
  });

  const res = await app.inject({
    method: "DELETE", url: "/",
    headers: JSON_HEADERS,
    payload: JSON.stringify({ ids: [ID, "m-2"] }),
  });

  assert.equal(res.statusCode, 202);
  assert.equal(res.json().jobId, "job-1");
  assert.deepEqual(seen!.ids, [ID, "m-2"]);
});

test("DELETE /: unauthenticated returns 401", async () => {
  const app = await build();
  const res = await app.inject({ method: "DELETE", url: "/" });
  assert.equal(res.statusCode, 401);
});

// ── the filter schema must mirror GET / ────────────────────────────────────────
//
// The list and bulk-delete routes must agree on every filter. They parse their
// query params in two separate Zod schemas (see media/library.ts), and neither
// is `.strict()`, so a filter added to one and forgotten in the other is dropped
// silently — which on the delete side turns "delete the 3 items on screen" into
// "delete everything".

test("DELETE /: carries missing=only into the delete job filters", async () => {
  let seen: { filters?: Record<string, unknown> } | null = null;
  const app = await build({
    deleteService: {
      startDelete: async (_u: string, input: { filters?: Record<string, unknown> }) => { seen = input; return { jobId: "job-1" }; },
    },
  });
  const res = await app.inject({ method: "DELETE", url: "/?missing=only", headers: AUTH });

  assert.equal(res.statusCode, 202);
  // Without this the job would match every item the user owns, not just the
  // missing ones the user was looking at when they hit "delete all".
  assert.equal(seen!.filters!.missing, "only");
});

test("DELETE /: an unfiltered delete still passes no missing filter", async () => {
  let seen: { filters?: Record<string, unknown> } | null = null;
  const app = await build({
    deleteService: {
      startDelete: async (_u: string, input: { filters?: Record<string, unknown> }) => { seen = input; return { jobId: "job-1" }; },
    },
  });
  const res = await app.inject({ method: "DELETE", url: "/", headers: AUTH });

  assert.equal(res.statusCode, 202);
  assert.equal(seen!.filters!.missing, undefined);
});

test("DELETE /: tag filters are lower-cased and split the same way the list route splits them", async () => {
  let seen: { filters?: Record<string, unknown> } | null = null;
  const app = await build({
    deleteService: {
      startDelete: async (_u: string, input: { filters?: Record<string, unknown> }) => { seen = input; return { jobId: "job-1" }; },
    },
  });
  const res = await app.inject({ method: "DELETE", url: "/?tags=Invoice,%20Receipt&excludeTags=Draft", headers: AUTH });

  assert.equal(res.statusCode, 202);
  assert.deepEqual(seen!.filters!.tags, ["invoice", "receipt"]);
  assert.deepEqual(seen!.filters!.excludeTags, ["draft"]);
});

// ── delete job status ──────────────────────────────────────────────────────────

test("GET /delete/status: returns the job's progress", async () => {
  const app = await build({ deleteService: { getStatus: async () => ({ jobId: "job-1", done: 5, total: 10 }) } });
  const res = await app.inject({ method: "GET", url: "/delete/status?jobId=job-1", headers: AUTH });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().done, 5);
});

test("GET /delete/status: an unknown job returns 404", async () => {
  const app = await build({ deleteService: { getStatus: async () => null } });
  const res = await app.inject({ method: "GET", url: "/delete/status?jobId=nope", headers: AUTH });
  assert.equal(res.statusCode, 404);
});

test("GET /delete/status: a missing jobId is rejected", async () => {
  const app = await build();
  const res = await app.inject({ method: "GET", url: "/delete/status", headers: AUTH });
  assert.equal(res.statusCode, 500); // ZodError
});

test("GET /delete/active: nothing running answers { status: null }", async () => {
  const app = await build();
  const res = await app.inject({ method: "GET", url: "/delete/active", headers: AUTH });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { status: null });
});

test("POST /delete/abort: returns the new epoch", async () => {
  const app = await build({ deleteService: { abort: async () => ({ epoch: 12 }) } });
  const res = await app.inject({ method: "POST", url: "/delete/abort", headers: AUTH });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { epoch: 12 });
});

test("POST /delete/abort: unauthenticated returns 401", async () => {
  const app = await build();
  const res = await app.inject({ method: "POST", url: "/delete/abort" });
  assert.equal(res.statusCode, 401);
});
