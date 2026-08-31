import test from "node:test";
import assert from "node:assert/strict";
import { buildRouteApp } from "../helpers/buildRouteApp.js";
import { mediaLibraryRoutes } from "@/routes/media/library.js";
import { mediaDuplicatesRoutes } from "@/routes/media/duplicates.js";
import { mediaEventsRoutes } from "@/routes/media/events.js";
import { mediaItemsRoutes } from "@/routes/media/items.js";
import { mediaContentRoutes } from "@/routes/media/content.js";
import { mediaDerivativesRoutes } from "@/routes/media/derivatives.js";
import { mediaIndexingRoutes } from "@/routes/media/indexing.js";
import { mediaDeleteJobRoutes } from "@/routes/media/deleteJobs.js";
import { mediaArchiveRoutes } from "@/routes/media/archives.js";

/**
 * The nine sibling plugins that replaced routes/media.ts must serve exactly the
 * URLs it served — the split was explicitly not an API change, and there are no
 * aliases or redirects to soften a mistake.
 *
 * This also catches the two boot-time failures the split can cause: a duplicate
 * route across two plugins (FST_ERR_DUPLICATED_ROUTE), and two files giving the
 * same path segment different param names.
 */

const MEDIA_ROUTES = [
  // Fastify drops the trailing slash on a prefixed plugin's root route, as it
  // did for the single routes/media.ts.
  "DELETE /api/media",
  "DELETE /api/media/:id",
  "GET /api/media",
  "GET /api/media/:id",
  "GET /api/media/:id/download",
  "GET /api/media/:id/source",
  "GET /api/media/:id/text",
  "GET /api/media/:id/text/queue-position",
  "GET /api/media/:id/thumbnail",
  "GET /api/media/delete/active",
  "GET /api/media/delete/status",
  "GET /api/media/duplicates",
  "GET /api/media/events",
  "GET /api/media/index/active",
  "GET /api/media/index/reconcile/state",
  "GET /api/media/index/roots",
  "GET /api/media/index/status",
  "GET /api/media/stats",
  "GET /api/media/storage",
  "GET /api/media/storage/categories",
  "GET /api/media/text/scanned/count",
  "PATCH /api/media/:id",
  "POST /api/media/:id/reveal",
  "POST /api/media/:id/star",
  "POST /api/media/:id/text",
  "POST /api/media/:id/text/cancel",
  "POST /api/media/:id/thumbnail/regenerate",
  "POST /api/media/:id/unpack",
  "POST /api/media/batch/text",
  "POST /api/media/batch/text/prioritize",
  "POST /api/media/batch/text/scanned",
  "POST /api/media/batch/thumbnail",
  "POST /api/media/batch/thumbnail/prioritize",
  "POST /api/media/bulk-download",
  "POST /api/media/delete/abort",
  "POST /api/media/duplicates/scan",
  "POST /api/media/index",
  "POST /api/media/index/reconcile",
  "POST /api/media/unpack-new",
];

test("the nine media plugins mount the frozen URL set at /api/media", async () => {
  const mounted: string[] = [];

  const app = await buildRouteApp(
    [
      mediaLibraryRoutes,
      mediaDuplicatesRoutes,
      mediaEventsRoutes,
      mediaItemsRoutes,
      mediaContentRoutes,
      mediaDerivativesRoutes,
      mediaIndexingRoutes,
      mediaDeleteJobRoutes,
      mediaArchiveRoutes,
    ],
    {
      prefix: "/api/media",
      onRoute: route => {
        for (const method of Array.isArray(route.method) ? route.method : [route.method]) {
          // Fastify registers a HEAD alongside every GET; the URL set is what matters.
          if (method === "HEAD") continue;
          mounted.push(`${method} ${route.url}`);
        }
      },
    },
  );

  // A duplicate route throws here, not at register time.
  await app.ready();

  assert.deepEqual(mounted.sort(), [...MEDIA_ROUTES].sort());
  assert.equal(mounted.length, 39, "39 routes — update the list above deliberately, never to make this pass");
});
