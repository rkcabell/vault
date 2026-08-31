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

type Row = {
  id: string;
  thumbState: string;
  textState: string;
  hashState?: string;
  updatedAt: Date;
  /** When the row was handed to a queue. NULL = still in the DB backlog waiting
   *  for the feeder, which is what stall detection now keys on. */
  thumbQueuedAt?: Date | null;
  textQueuedAt?: Date | null;
  hashQueuedAt?: Date | null;
};

/**
 * Builds a MediaRepository backed by a single in-memory row.
 * The mock updateMany applies the WHERE clause before updating, mirroring
 * Postgres behaviour, so illegal-transition guards are exercised.
 */
function buildRepo (initial: Omit<Row, "id">) {
  const row: Row = { id: "media-1", thumbQueuedAt: null, textQueuedAt: null, hashQueuedAt: null, ...initial };

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

        // hashState check
        if (where.hashState !== undefined && where.hashState !== row.hashState) {
          return { count: 0 };
        }

        Object.assign(row, data);
        return { count: 1 };
      },

      findMany: async ({ where }: { where: any }) => {
        if (!where?.OR) return [row];
        // Mirrors the timestamp filter Postgres applies: `{ not: null, lt: d }`
        // excludes NULL, which is the whole point — a row that was never
        // dispatched has not stalled, it is simply still waiting to be fed.
        const stampMatches = (cond: any, value: Date | null | undefined) => {
          if (cond === undefined) return true;
          if (cond.not === null && (value === null || value === undefined)) return false;
          if (cond.lt instanceof Date && !(value instanceof Date && value < cond.lt)) return false;
          return true;
        };
        const matches = (where.OR as any[]).some(cond => {
          if (cond.thumbState !== undefined && cond.thumbState !== row.thumbState) return false;
          if (cond.textState !== undefined && cond.textState !== row.textState) return false;
          if (cond.hashState !== undefined && cond.hashState !== row.hashState) return false;
          if (cond.updatedAt?.lt instanceof Date && row.updatedAt >= cond.updatedAt.lt) return false;
          if (!stampMatches(cond.thumbQueuedAt, row.thumbQueuedAt)) return false;
          if (!stampMatches(cond.textQueuedAt, row.textQueuedAt)) return false;
          if (!stampMatches(cond.hashQueuedAt, row.hashQueuedAt)) return false;
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

// The one state the guard refuses, and it is reachable from the UI: the worker
// marks a text/* file over MAX_TEXT_BYTES UNSUPPORTED, but its mime still clears
// ocrSupported, so "Extract text" reaches the transition. The caller has to read
// this false — enqueueing past it produced a job the worker discarded unrun.
test("setTextStatePending: UNSUPPORTED → PENDING is refused (too-large text file)", async () => {
  const { repo, row } = buildRepo({
    thumbState: "READY",
    textState: "UNSUPPORTED",
    updatedAt: new Date(),
  });
  const updated = await repo.setTextStatePending("media-1");
  assert.equal(updated, false);
  assert.equal(row.textState, "UNSUPPORTED");
  assert.equal(row.textQueuedAt, null, "a refused transition must not stamp the row dispatched");
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
// hashState transitions
// ---------------------------------------------------------------------------

test("setHashState(READY): PENDING → READY succeeds", async () => {
  const { repo, row } = buildRepo({
    thumbState: "READY",
    textState: "READY",
    hashState: "PENDING",
    updatedAt: new Date(),
  });
  const updated = await repo.setHashState("media-1", "READY");
  assert.equal(updated, true);
  assert.equal(row.hashState, "READY");
});

test("setHashState(FAILED): PENDING → FAILED succeeds", async () => {
  const { repo, row } = buildRepo({
    thumbState: "READY",
    textState: "READY",
    hashState: "PENDING",
    updatedAt: new Date(),
  });
  const updated = await repo.setHashState("media-1", "FAILED");
  assert.equal(updated, true);
  assert.equal(row.hashState, "FAILED");
});

test("setHashState: READY → READY is blocked (late worker after stall detection already resolved it)", async () => {
  const { repo, row } = buildRepo({
    thumbState: "READY",
    textState: "READY",
    hashState: "READY",
    updatedAt: new Date(),
  });
  const updated = await repo.setHashState("media-1", "FAILED");
  assert.equal(updated, false);
  assert.equal(row.hashState, "READY", "hashState must not change");
});

// ---------------------------------------------------------------------------
// Stall detection
// ---------------------------------------------------------------------------

test("markStalledJobs: marks records dispatched past the threshold", async () => {
  const staleDate = new Date(Date.now() - 20 * 60 * 1000); // 20 min ago
  const { repo, row } = buildRepo({
    thumbState: "PENDING",
    textState: "PENDING",
    hashState: "PENDING",
    updatedAt: staleDate,
    thumbQueuedAt: staleDate,
    textQueuedAt: staleDate,
    hashQueuedAt: staleDate,
  });

  await markStalledJobs(repo, logger, 15);

  assert.equal(row.thumbState, "FAILED");
  assert.equal(row.textState, "ERROR");
  assert.equal(row.hashState, "FAILED");
});

test("markStalledJobs: ignores records dispatched within the threshold", async () => {
  const recentDate = new Date(); // just now
  const { repo, row } = buildRepo({
    thumbState: "PENDING",
    textState: "PENDING",
    hashState: "PENDING",
    updatedAt: recentDate,
    thumbQueuedAt: recentDate,
    textQueuedAt: recentDate,
    hashQueuedAt: recentDate,
  });

  await markStalledJobs(repo, logger, 15);

  assert.equal(row.thumbState, "PENDING", "recently dispatched PENDING must not be touched");
  assert.equal(row.textState, "PENDING", "recently dispatched PENDING must not be touched");
  assert.equal(row.hashState, "PENDING", "recently dispatched PENDING must not be touched");
});

test("markStalledJobs: never touches a row that was never dispatched, however old", async () => {
  // The load-bearing case for the pull model. Most of a 190k-file library sits at
  // PENDING with no dispatch stamp for hours or days — that is the backlog
  // working as designed, not a stall. Keying stall detection on `updatedAt`, as
  // it did before the feeder, would mark the entire library FAILED/ERROR fifteen
  // minutes into the first index.
  const ancient = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // a month ago
  const { repo, row } = buildRepo({
    thumbState: "PENDING",
    textState: "PENDING",
    hashState: "PENDING",
    updatedAt: ancient,
    thumbQueuedAt: null,
    textQueuedAt: null,
    hashQueuedAt: null,
  });

  await markStalledJobs(repo, logger, 15);

  assert.equal(row.thumbState, "PENDING", "an un-fed row is waiting, not stalled");
  assert.equal(row.textState, "PENDING", "an un-fed row is waiting, not stalled");
  assert.equal(row.hashState, "PENDING", "an un-fed row is waiting, not stalled");
});

test("markStalledJobs: a hash job stalled alone (thumb/text already settled) is still caught", async () => {
  const staleDate = new Date(Date.now() - 20 * 60 * 1000);
  const { repo, row } = buildRepo({
    thumbState: "READY",
    textState: "READY",
    hashState: "PENDING",
    updatedAt: staleDate,
    hashQueuedAt: staleDate,
  });

  await markStalledJobs(repo, logger, 15);

  assert.equal(row.thumbState, "READY", "READY must not be overwritten");
  assert.equal(row.textState, "READY", "READY must not be overwritten");
  assert.equal(row.hashState, "FAILED");
});

test("markStalledJobs: ignores records that are already terminal", async () => {
  const staleDate = new Date(Date.now() - 20 * 60 * 1000);
  const { repo, row } = buildRepo({
    thumbState: "READY",
    textState: "ERROR",
    hashState: "UNSUPPORTED",
    updatedAt: staleDate,
  });

  await markStalledJobs(repo, logger, 15);

  assert.equal(row.thumbState, "READY", "READY must not be overwritten");
  assert.equal(row.textState, "ERROR", "ERROR must not be overwritten");
  assert.equal(row.hashState, "UNSUPPORTED", "UNSUPPORTED must not be overwritten");
});
