// File: apps/api/src/tests/api/worker/workerStateLifecycle.test.ts
//
// Tests for the state machine enforced by MediaRepository.
//
// The repository uses updateMany with conditional WHERE clauses so that illegal
// transitions (e.g., FAILED → READY written by a late-arriving worker) are
// silently rejected at the database level rather than relying on application
// guards scattered across multiple services.
//
// Each test builds a tiny in-memory "database" (a single row object) whose
// updateMany / findMany implementations apply the WHERE filter the same way
// a real Postgres query would. This validates the WHERE logic in the repo
// methods without needing a live database.

import test from "node:test";
import assert from "node:assert/strict";
import { MediaRepository } from "@/repositories/mediaRepository.js";
import { markStalledJobs } from "@/services/stallDetectionService.js";
import { createLogger } from "@/lib/logger.js";

// ---------------------------------------------------------------------------
// Minimal in-memory mock
// ---------------------------------------------------------------------------

type Row = { id: string; thumbState: string; textState: string; updatedAt: Date };

/**
 * Builds a MediaRepository backed by a single in-memory row.
 * The mock updateMany applies the WHERE clause before updating, mirroring
 * Postgres behaviour, so illegal-transition guards are actually exercised.
 */
function buildRepo (initial: Omit<Row, "id">) {
  const row: Row = { id: "media-1", ...initial };

  const prisma = {
    media: {
      updateMany: async ({ where, data }: { where: any; data: any }) => {
        // id check — handle both scalar ("media-1") and list ({ in: [...] }) forms
        if (where.id !== undefined) {
          if (typeof where.id === "string" && where.id !== row.id) return { count: 0 };
          if (where.id?.in && !(where.id.in as string[]).includes(row.id)) return { count: 0 };
        }

        // thumbState check
        if (where.thumbState !== undefined && where.thumbState !== row.thumbState) {
          return { count: 0 };
        }

        // textState check
        if (where.textState !== undefined) {
          const cond = where.textState;
          if (typeof cond === "string" && cond !== row.textState) return { count: 0 };
          if (cond?.in && !(cond.in as string[]).includes(row.textState)) return { count: 0 };
        }

        Object.assign(row, data);
        return { count: 1 };
      },

      findMany: async ({ where }: { where: any }) => {
        if (!where?.OR) return [row];
        const matches = (where.OR as any[]).some(cond => {
          if (cond.thumbState !== undefined && cond.thumbState !== row.thumbState) return false;
          if (cond.textState !== undefined && cond.textState !== row.textState) return false;
          if (cond.updatedAt?.lt instanceof Date && row.updatedAt >= cond.updatedAt.lt) return false;
          return true;
        });
        return matches ? [row] : [];
      },
    } as any,
  } as any;

  return { repo: new MediaRepository(prisma), row };
}

const logger = createLogger("test");

// ---------------------------------------------------------------------------
// thumbState transitions
// ---------------------------------------------------------------------------

test("setThumbReady: PENDING → READY succeeds", async () => {
  const { repo, row } = buildRepo({
    thumbState: "PENDING",
    textState: "PENDING",
    updatedAt: new Date(),
  });
  const updated = await repo.setThumbReady("media-1", "thumbs/media-1.webp");
  assert.equal(updated, true);
  assert.equal(row.thumbState, "READY");
});

test("setThumbReady: FAILED → READY is blocked (illegal transition)", async () => {
  const { repo, row } = buildRepo({
    thumbState: "FAILED",
    textState: "PENDING",
    updatedAt: new Date(),
  });
  const updated = await repo.setThumbReady("media-1", "thumbs/media-1.webp");
  assert.equal(updated, false);
  assert.equal(row.thumbState, "FAILED", "thumbState must not change");
});

test("setThumbReady: READY → READY is a no-op (idempotent guard)", async () => {
  const { repo, row } = buildRepo({
    thumbState: "READY",
    textState: "READY",
    updatedAt: new Date(),
  });
  const updated = await repo.setThumbReady("media-1", "thumbs/media-1.webp");
  assert.equal(updated, false);
  assert.equal(row.thumbState, "READY");
});

test("setThumbFailed: PENDING → FAILED succeeds", async () => {
  const { repo, row } = buildRepo({
    thumbState: "PENDING",
    textState: "PENDING",
    updatedAt: new Date(),
  });
  const updated = await repo.setThumbFailed("media-1", "render failed");
  assert.equal(updated, true);
  assert.equal(row.thumbState, "FAILED");
});

test("setThumbFailed: READY → FAILED is blocked (no retrograde failure)", async () => {
  const { repo, row } = buildRepo({
    thumbState: "READY",
    textState: "PENDING",
    updatedAt: new Date(),
  });
  const updated = await repo.setThumbFailed("media-1", "late error");
  assert.equal(updated, false);
  assert.equal(row.thumbState, "READY", "thumbState must not change");
});

// ---------------------------------------------------------------------------
// textState transitions
// ---------------------------------------------------------------------------

test("setTextState(READY): PENDING → READY succeeds", async () => {
  const { repo, row } = buildRepo({
    thumbState: "PENDING",
    textState: "PENDING",
    updatedAt: new Date(),
  });
  const updated = await repo.setTextState("media-1", "READY");
  assert.equal(updated, true);
  assert.equal(row.textState, "READY");
});

test("setTextState(READY): ERROR → READY is blocked (late worker after cancel)", async () => {
  const { repo, row } = buildRepo({
    thumbState: "PENDING",
    textState: "ERROR",
    updatedAt: new Date(),
  });
  const updated = await repo.setTextState("media-1", "READY");
  assert.equal(updated, false);
  assert.equal(row.textState, "ERROR", "textState must not change");
});

test("setTextState(ERROR): PENDING → ERROR succeeds", async () => {
  const { repo, row } = buildRepo({
    thumbState: "PENDING",
    textState: "PENDING",
    updatedAt: new Date(),
  });
  const updated = await repo.setTextState("media-1", "ERROR");
  assert.equal(updated, true);
  assert.equal(row.textState, "ERROR");
});

test("setTextStatePending: READY → PENDING succeeds (re-run)", async () => {
  const { repo, row } = buildRepo({
    thumbState: "READY",
    textState: "READY",
    updatedAt: new Date(),
  });
  const updated = await repo.setTextStatePending("media-1");
  assert.equal(updated, true);
  assert.equal(row.textState, "PENDING");
});

test("setTextStatePending: ERROR → PENDING succeeds (re-run after failure)", async () => {
  const { repo, row } = buildRepo({
    thumbState: "PENDING",
    textState: "ERROR",
    updatedAt: new Date(),
  });
  const updated = await repo.setTextStatePending("media-1");
  assert.equal(updated, true);
  assert.equal(row.textState, "PENDING");
});

// ---------------------------------------------------------------------------
// Full text-state lifecycle
// ---------------------------------------------------------------------------

test("text state full lifecycle: PENDING → READY → PENDING (re-run) → ERROR → PENDING → READY", async () => {
  const { repo, row } = buildRepo({
    thumbState: "PENDING",
    textState: "PENDING",
    updatedAt: new Date(),
  });

  // Worker completes successfully
  assert.equal(await repo.setTextState("media-1", "READY"), true);
  assert.equal(row.textState, "READY");

  // User triggers re-run
  assert.equal(await repo.setTextStatePending("media-1"), true);
  assert.equal(row.textState, "PENDING");

  // Worker fails (non-transient)
  assert.equal(await repo.setTextState("media-1", "ERROR"), true);
  assert.equal(row.textState, "ERROR");

  // Late duplicate worker tries to write READY — must be blocked
  assert.equal(await repo.setTextState("media-1", "READY"), false);
  assert.equal(row.textState, "ERROR", "ERROR must not be overwritten by stale worker");

  // User triggers second re-run
  assert.equal(await repo.setTextStatePending("media-1"), true);
  assert.equal(row.textState, "PENDING");

  // Worker completes
  assert.equal(await repo.setTextState("media-1", "READY"), true);
  assert.equal(row.textState, "READY");
});

// ---------------------------------------------------------------------------
// Stall detection
// ---------------------------------------------------------------------------

test("markStalledJobs: marks records stuck at PENDING past the threshold", async () => {
  const staleDate = new Date(Date.now() - 20 * 60 * 1000); // 20 min ago
  const { repo, row } = buildRepo({
    thumbState: "PENDING",
    textState: "PENDING",
    updatedAt: staleDate,
  });

  await markStalledJobs(repo, logger, 15);

  assert.equal(row.thumbState, "FAILED");
  assert.equal(row.textState, "ERROR");
});

test("markStalledJobs: ignores PENDING records that are still within the threshold", async () => {
  const recentDate = new Date(); // just now
  const { repo, row } = buildRepo({
    thumbState: "PENDING",
    textState: "PENDING",
    updatedAt: recentDate,
  });

  await markStalledJobs(repo, logger, 15);

  assert.equal(row.thumbState, "PENDING", "recent PENDING must not be touched");
  assert.equal(row.textState, "PENDING", "recent PENDING must not be touched");
});

test("markStalledJobs: ignores records that are already terminal", async () => {
  const staleDate = new Date(Date.now() - 20 * 60 * 1000);
  const { repo, row } = buildRepo({
    thumbState: "READY",
    textState: "ERROR",
    updatedAt: staleDate,
  });

  await markStalledJobs(repo, logger, 15);

  assert.equal(row.thumbState, "READY", "READY must not be overwritten");
  assert.equal(row.textState, "ERROR", "ERROR must not be overwritten");
});
