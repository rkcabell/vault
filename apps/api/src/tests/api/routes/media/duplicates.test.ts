import test from "node:test";
import assert from "node:assert/strict";
import { mediaDuplicatesRoutes } from "@/routes/media/duplicates.js";
import { buildRouteApp, AUTH } from "../helpers/buildRouteApp.js";

const build = (services = {}) => buildRouteApp(mediaDuplicatesRoutes, { services });

test("GET /duplicates: returns the groups and the unhashed count", async () => {
  const app = await build({
    dedupService: {
      listDuplicateGroups: async () => ({
        groups: [{ contentHash: "abc", items: [{ id: "m-1" }, { id: "m-2" }] }],
        unhashedReady: 3,
      }),
    },
  });
  const res = await app.inject({ method: "GET", url: "/duplicates", headers: AUTH });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().groups.length, 1);
  assert.equal(res.json().unhashedReady, 3);
});

test("GET /duplicates: unauthenticated returns 401", async () => {
  const app = await build();
  const res = await app.inject({ method: "GET", url: "/duplicates" });
  assert.equal(res.statusCode, 401);
});

test("POST /duplicates/scan: returns how many hash jobs the backfill queued", async () => {
  const app = await build({ dedupService: { startScan: async () => ({ queued: 12 }) } });
  const res = await app.inject({ method: "POST", url: "/duplicates/scan", headers: AUTH });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { queued: 12 });
});

test("POST /duplicates/scan: unauthenticated returns 401", async () => {
  const app = await build();
  const res = await app.inject({ method: "POST", url: "/duplicates/scan" });
  assert.equal(res.statusCode, 401);
});
