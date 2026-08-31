import test from "node:test";
import assert from "node:assert/strict";
import { createJobControlService } from "@/services/media/jobControlService.js";

// ── abortProcessing ───────────────────────────────────────────────────────────

type Deps = Parameters<typeof createJobControlService>[0];
type AnyQueue = NonNullable<Deps["indexQueue"]>;

type QueueCalls = { drained: boolean; paused: boolean; resumed: boolean; cleaned: string[] };

/** A fake queue that records the abort lifecycle. `failOn` makes one step throw. */
function makeAbortQueue (
  name: string,
  log: Record<string, QueueCalls>,
  opts: { failOn?: "pause" | "drain" | "clean" } = {},
) {
  const calls: QueueCalls = { drained: false, paused: false, resumed: false, cleaned: [] };
  log[name] = calls;
  return {
    pause: async () => { if (opts.failOn === "pause") throw new Error("x"); calls.paused = true; },
    drain: async () => { if (opts.failOn === "drain") throw new Error("x"); calls.drained = true; },
    clean: async (_g: number, _l: number, type: string) => { if (opts.failOn === "clean") throw new Error("x"); calls.cleaned.push(type); },
    resume: async () => { calls.resumed = true; },
  } as unknown as AnyQueue;
}

const castReconcile = (q: AnyQueue) => q as unknown as Deps["reconcileQueue"];

test("abortProcessing: pauses, drains, cleans, then resumes the index queue", async () => {
  const log: Record<string, QueueCalls> = {};
  const svc = createJobControlService({ indexQueue: makeAbortQueue("index", log) });

  const result = await svc.abortProcessing();
  assert.equal(result.ok, true);
  // Only the producer queues are drained — thumb/ocr jobs already enqueued are
  // left to finish so no thumbnails or text are lost mid-walk.
  assert.deepEqual(result.cleared, ["index"]);
  assert.equal(log["index"].paused, true, "index paused");
  assert.equal(log["index"].drained, true, "index drained");
  assert.deepEqual(log["index"].cleaned.sort(), ["completed", "failed"], "index cleaned terminal");
  assert.equal(log["index"].resumed, true, "index resumed");
});

test("abortProcessing: drains reconcile alongside index", async () => {
  const log: Record<string, QueueCalls> = {};
  const svc = createJobControlService({
    indexQueue: makeAbortQueue("index", log),
    reconcileQueue: castReconcile(makeAbortQueue("reconcile", log)),
  });

  const result = await svc.abortProcessing();

  // The epoch alone does not cover a *queued* sweep: a walk reads the epoch at
  // start, so one that hasn't started yet picks up the new value and runs.
  assert.deepEqual(result.cleared, ["index", "reconcile"]);
  assert.equal(log["reconcile"].drained, true);
  assert.equal(log["reconcile"].resumed, true, "never left paused");
});

test("abortProcessing: bumps both the index-abort and reconcile-abort epochs", async () => {
  const log: Record<string, QueueCalls> = {};
  const incrKeys: string[] = [];
  const svc = createJobControlService({
    indexQueue: makeAbortQueue("index", log),
    redis: { incr: async (key: string) => { incrKeys.push(key); return incrKeys.length; } },
  });

  await svc.abortProcessing();
  // Cancel scan stops whichever of the two is running, so both epochs bump —
  // a queued-but-not-started reconcile sweep must not survive on the old value.
  assert.equal(incrKeys.length, 2, "both epochs incremented once each");
  assert.deepEqual(incrKeys.sort(), ["vault:index:abort-epoch", "vault:reconcile:abort-epoch"]);
});

test("abortProcessing: still drains the index queue when no redis is wired (signal skipped)", async () => {
  const log: Record<string, QueueCalls> = {};
  const svc = createJobControlService({ indexQueue: makeAbortQueue("index", log) });

  const result = await svc.abortProcessing();
  assert.deepEqual(result.cleared, ["index"]);
});

test("abortProcessing: never obliterates (no active jobs are yanked mid-process)", async () => {
  let obliterated = false;
  const q = { pause: async () => {}, drain: async () => {}, clean: async () => {}, resume: async () => {},
    obliterate: async () => { obliterated = true; } } as unknown as AnyQueue;
  const svc = createJobControlService({ indexQueue: q });
  await svc.abortProcessing();
  assert.equal(obliterated, false, "must not call obliterate — that causes the Missing-key worker error");
});

test("abortProcessing: no-ops cleanly when no queue is wired", async () => {
  const svc = createJobControlService({});

  const result = await svc.abortProcessing();
  assert.equal(result.ok, true);
  assert.deepEqual(result.cleared, []);
});

test("abortProcessing: a failing drain still resumes the queue (never left paused)", async () => {
  const log: Record<string, QueueCalls> = {};
  const svc = createJobControlService({
    indexQueue: makeAbortQueue("index", log, { failOn: "drain" }),
  });

  const result = await svc.abortProcessing();
  assert.equal(result.ok, true);
  // index drain threw → not reported as cleared, but it must still be resumed.
  assert.deepEqual(result.cleared, []);
  assert.equal(log["index"].resumed, true, "failing queue is resumed in finally");
});

// ── abortReconcile ─────────────────────────────────────────────────────────────

test("abortReconcile: pauses, drains, cleans, then resumes only the reconcile queue", async () => {
  const log: Record<string, QueueCalls> = {};
  const svc = createJobControlService({
    indexQueue: makeAbortQueue("index", log),
    reconcileQueue: castReconcile(makeAbortQueue("reconcile", log)),
  });

  const result = await svc.abortReconcile();
  assert.deepEqual(result, { ok: true, cleared: ["reconcile"] });
  assert.equal(log["reconcile"].paused, true, "reconcile paused");
  assert.equal(log["reconcile"].drained, true, "reconcile drained");
  assert.deepEqual(log["reconcile"].cleaned.sort(), ["completed", "failed"], "reconcile cleaned terminal");
  assert.equal(log["reconcile"].resumed, true, "reconcile resumed");
  // An unrelated, hours-long index scan must be left running.
  assert.equal(log["index"].paused, false, "index untouched");
  assert.equal(log["index"].drained, false, "index untouched");
  assert.equal(log["index"].resumed, false, "index untouched");
});

test("abortReconcile: bumps only the reconcile-abort epoch, never the index one", async () => {
  const log: Record<string, QueueCalls> = {};
  const incrKeys: string[] = [];
  const svc = createJobControlService({
    reconcileQueue: castReconcile(makeAbortQueue("reconcile", log)),
    redis: { incr: async (key: string) => { incrKeys.push(key); return incrKeys.length; } },
  });

  await svc.abortReconcile();
  assert.deepEqual(incrKeys, ["vault:reconcile:abort-epoch"]);
});

test("abortReconcile: no-ops cleanly when reconcileQueue is undefined", async () => {
  const svc = createJobControlService({ indexQueue: makeAbortQueue("index", {}) });

  const result = await svc.abortReconcile();
  assert.equal(result.ok, true);
  assert.deepEqual(result.cleared, []);
});

test("abortReconcile: never obliterates (no active jobs are yanked mid-process)", async () => {
  let obliterated = false;
  const q = { pause: async () => {}, drain: async () => {}, clean: async () => {}, resume: async () => {},
    obliterate: async () => { obliterated = true; } } as unknown as AnyQueue;
  const svc = createJobControlService({ reconcileQueue: castReconcile(q) });
  await svc.abortReconcile();
  assert.equal(obliterated, false, "must not call obliterate — that causes the Missing-key worker error");
});

test("abortReconcile: a failing drain still resumes the queue (never left paused)", async () => {
  const log: Record<string, QueueCalls> = {};
  const svc = createJobControlService({
    reconcileQueue: castReconcile(makeAbortQueue("reconcile", log, { failOn: "drain" })),
  });

  const result = await svc.abortReconcile();
  assert.equal(result.ok, true);
  // reconcile drain threw → not reported as cleared, but it must still be resumed.
  assert.deepEqual(result.cleared, []);
  assert.equal(log["reconcile"].resumed, true, "failing queue is resumed in finally");
});
