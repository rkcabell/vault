import test from "node:test";
import assert from "node:assert/strict";
import { createDerivativeProgressTracker } from "@/services/media/derivativeProgress.js";
import type { DerivativeProgressCounts } from "@/repositories/mediaRepository.js";

function counts (over: Partial<DerivativeProgressCounts> = {}): DerivativeProgressCounts {
  return {
    thumb: { pending: 0, ready: 0, failed: 0, unsupported: 0 },
    text: { pending: 0, ready: 0, needsOcr: 0, error: 0, unsupported: 0 },
    hash: { pending: 0, ready: 0, unsupported: 0 },
    ...over,
  };
}

function makeClock (start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

test("derivativeProgress: a single sample has no rate/ETA yet", async () => {
  const clock = makeClock();
  const tracker = createDerivativeProgressTracker({
    repository: {
      countDerivativeProgress: async () => counts({ thumb: { pending: 100, ready: 0, failed: 0, unsupported: 0 } }),
    },
    now: clock.now,
  });

  const result = await tracker.read("u1");

  assert.equal(result.thumb.ratePerSec, null, "no fabricated rate on the first-ever read");
  assert.equal(result.thumb.etaSeconds, null);
  assert.equal(result.thumb.pending, 100);
});

test("derivativeProgress: rate and ETA are computed across two samples", async () => {
  const clock = makeClock();
  const seq = [
    counts({ thumb: { pending: 100, ready: 0, failed: 0, unsupported: 0 } }),
    counts({ thumb: { pending: 50, ready: 50, failed: 0, unsupported: 0 } }),
  ];
  let call = 0;
  const tracker = createDerivativeProgressTracker({
    repository: { countDerivativeProgress: async () => seq[call++] },
    now: clock.now,
    sampleIntervalMs: 5000,
  });

  await tracker.read("u1"); // t=0, ready=0
  clock.advance(5000);
  const result = await tracker.read("u1"); // t=5000, ready=50

  assert.equal(result.thumb.ratePerSec, 10, "(50 - 0) ready over 5s = 10/s");
  assert.equal(result.thumb.pending, 50);
  assert.equal(result.thumb.etaSeconds, 5, "50 pending / 10 per sec");
});

test("derivativeProgress: throttles database reads within the sample interval", async () => {
  const clock = makeClock();
  let queries = 0;
  const tracker = createDerivativeProgressTracker({
    repository: { countDerivativeProgress: async () => { queries++; return counts(); } },
    now: clock.now,
    sampleIntervalMs: 5000,
  });

  await tracker.read("u1");
  clock.advance(1000); // still inside the 5s window
  await tracker.read("u1");
  await tracker.read("u1");

  assert.equal(queries, 1, "sub-interval reads reuse the cached counts rather than hitting the DB again");
});

test("derivativeProgress: samples again once the interval has elapsed", async () => {
  const clock = makeClock();
  let queries = 0;
  const tracker = createDerivativeProgressTracker({
    repository: { countDerivativeProgress: async () => { queries++; return counts(); } },
    now: clock.now,
    sampleIntervalMs: 5000,
  });

  await tracker.read("u1");
  clock.advance(5000);
  await tracker.read("u1");

  assert.equal(queries, 2);
});

test("derivativeProgress: null ETA when the rate is flat (zero)", async () => {
  const clock = makeClock();
  const seq = [
    counts({ thumb: { pending: 10, ready: 20, failed: 0, unsupported: 0 } }),
    counts({ thumb: { pending: 10, ready: 20, failed: 0, unsupported: 0 } }),
  ];
  let call = 0;
  const tracker = createDerivativeProgressTracker({
    repository: { countDerivativeProgress: async () => seq[call++] },
    now: clock.now,
    sampleIntervalMs: 1000,
  });

  await tracker.read("u1");
  clock.advance(1000);
  const result = await tracker.read("u1");

  assert.equal(result.thumb.ratePerSec, 0);
  assert.equal(result.thumb.etaSeconds, null, "zero rate must not divide out to Infinity or 0s");
});

test("derivativeProgress: null ETA when nothing is pending, even with a positive rate", async () => {
  const clock = makeClock();
  const seq = [
    counts({ thumb: { pending: 10, ready: 0, failed: 0, unsupported: 0 } }),
    counts({ thumb: { pending: 0, ready: 10, failed: 0, unsupported: 0 } }),
  ];
  let call = 0;
  const tracker = createDerivativeProgressTracker({
    repository: { countDerivativeProgress: async () => seq[call++] },
    now: clock.now,
    sampleIntervalMs: 1000,
  });

  await tracker.read("u1");
  clock.advance(1000);
  const result = await tracker.read("u1");

  assert.ok((result.thumb.ratePerSec ?? 0) > 0, "sanity: the rate itself is real");
  assert.equal(result.thumb.etaSeconds, null, "an idle queue shows no ETA rather than 0s remaining");
});

test("derivativeProgress: the ring buffer evicts samples outside the rate window", async () => {
  const clock = makeClock();
  // A one-time burst (0 → 1000 in a single tick) followed by a steady 10/s
  // climb. Without eviction the burst keeps dragging the computed rate toward
  // a huge number indefinitely; with a 3s window it ages out of the buffer
  // and the rate settles to the true steady-state value.
  const readySeq = [0, 1000, 1010, 1020, 1030, 1040];
  let call = 0;
  const tracker = createDerivativeProgressTracker({
    repository: {
      countDerivativeProgress: async () => counts({ thumb: { pending: 0, ready: readySeq[call++], failed: 0, unsupported: 0 } }),
    },
    now: clock.now,
    sampleIntervalMs: 1000,
    windowMs: 3000,
  });

  let result = await tracker.read("u1"); // t=0, ready=0 (before the burst)
  for (let i = 0; i < 5; i++) {
    clock.advance(1000);
    result = await tracker.read("u1");
  }
  // t=5000, ready=1040. Without eviction this would read (1040-0)/5s = 208/s.
  assert.equal(result.thumb.ratePerSec, 10, "settles to the steady-state rate once the burst sample ages out");
});

test("derivativeProgress: per-user isolation — one user's samples never leak into another's rate", async () => {
  const clock = makeClock();
  const readyByUser: Record<string, number> = { u1: 0, u2: 0 };
  const tracker = createDerivativeProgressTracker({
    repository: {
      countDerivativeProgress: async (userId: string) =>
        counts({ thumb: { pending: 100, ready: readyByUser[userId], failed: 0, unsupported: 0 } }),
    },
    now: clock.now,
    sampleIntervalMs: 1000,
  });

  await tracker.read("u1");
  await tracker.read("u2");
  clock.advance(1000);
  readyByUser.u1 = 20; // only u1 progressed
  const u1 = await tracker.read("u1");
  const u2 = await tracker.read("u2");

  assert.equal(u1.thumb.ratePerSec, 20);
  assert.equal(u2.thumb.ratePerSec, 0);
});

test("derivativeProgress: a user's buffer is pruned after pruneAfterMs unread", async () => {
  const clock = makeClock();
  const tracker = createDerivativeProgressTracker({
    repository: {
      countDerivativeProgress: async () => counts({ thumb: { pending: 10, ready: 100, failed: 0, unsupported: 0 } }),
    },
    now: clock.now,
    sampleIntervalMs: 1000,
    pruneAfterMs: 5000,
  });

  await tracker.read("u1");
  clock.advance(10_000); // well past pruneAfterMs with no read in between
  const result = await tracker.read("u1");

  // The stale buffer was dropped, so this reads like a first-ever sample again
  // — no rate across the unwatched gap — rather than computing a rate that
  // includes ten seconds nobody was polling.
  assert.equal(result.thumb.ratePerSec, null);
});

test("derivativeProgress: needsOcr passes through, and folds into text.pending for the ETA", async () => {
  const tracker = createDerivativeProgressTracker({
    repository: {
      countDerivativeProgress: async () =>
        counts({ text: { pending: 5, ready: 100, needsOcr: 42, error: 0, unsupported: 0 } }),
    },
  });

  const result = await tracker.read("u1");

  assert.equal(result.needsOcr, 42);
  // Tier-1 pending alone would understate the real backlog and show a
  // near-zero ETA with a five-figure OCR backlog still sitting there.
  assert.equal(result.text.pending, 5 + 42);
});
