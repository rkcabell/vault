import test from "node:test";
import assert from "node:assert/strict";
import { mediaEventsRoutes } from "@/routes/media/events.js";
import { buildRouteApp } from "../helpers/buildRouteApp.js";

// The success path uses reply.hijack() + raw socket streaming and cannot be
// captured by app.inject(). Only the auth guard is tested here.
test("GET /events: unauthenticated returns 401", async () => {
  const app = await buildRouteApp(mediaEventsRoutes);
  const res = await app.inject({ method: "GET", url: "/events" });
  assert.equal(res.statusCode, 401);
});
