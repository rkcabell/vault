import test from "node:test";
import assert from "node:assert/strict";
import { createDerivativeFeeder, type DerivativeFeederDeps } from "@/services/media/derivativeFeeder.js";

const logger = { info: () => {}, error: () => {} };

type ClaimRow = { id: string; userId: string; storageKey: string; sourcePath: string | null };

/** A backlog of `total` claimable rows, handed out in bounded claims. */
function makeBacklog (total: number, opts: { sourcePath?: (n: number) => string | null } = {}) {
  let remaining = total;
  let next = 0;
  const claims: number[] = [];
  const claim = async (limit: number): Promise<ClaimRow[]> => {
    claims.push(limit);
    const take = Math.max(0, Math.min(limit, remaining));
    remaining -= take;
    return Array.from({ length: take }, () => {
      const n = next++;
      return {
        id: `m${n}`,
        userId: "u1",
        storageKey: `k${n}`,
        sourcePath: opts.sourcePath ? opts.sourcePath(n) : null,
      };
    });
  };
  return { claim, claims, left: () => remaining };
}

type AddedJob = {
  data: { mediaId: string; allowedRoots?: string[]; sourcePath?: string };
  opts?: { lifo?: boolean };
};

/** A queue whose depth the feeder reads, recording everything added to it.
 *  `existingJobIds` stand in for jobs already dispatched into Redis, which the
 *  promotion path reprioritises rather than re-adding. */
function makeQueue (depth = 0, existingJobIds: string[] = []) {
  const added: AddedJob[] = [];
  const reprioritized: string[] = [];
  const existing = new Set(existingJobIds);
  return {
    added,
    reprioritized,
    queue: {
      getJobCounts: async () => ({ waiting: depth, active: 0, delayed: 0, prioritized: 0 }),
      addBulk: async (jobs: AddedJob[]) => {
        added.push(...jobs);
      },
      getJob: async (id: string) =>
        existing.has(id)
          ? { changePriority: async (opts: { lifo?: boolean }) => { reprioritized.push(`${id}:${opts.lifo}`); } }
          : undefined,
    },
  };
}

function makeFeeder (over: {
  thumbBacklog?: number;
  textBacklog?: number;
  thumbDepth?: number;
  textDepth?: number;
  allowedRoots?: string[];
  sourcePath?: (n: number) => string | null;
  released?: { kind: string; ids: string[] }[];
  thumbAddBulk?: () => Promise<void>;
  highWater?: number;
  lowWater?: number;
  /** Ids claimThumbByIds will hand back — i.e. still in the backlog. */
  promotable?: string[];
  /** Ids that already have a job in the queue. */
  dispatched?: string[];
  hashBacklog?: number;
  hashDepth?: number;
  hashAddBulk?: () => Promise<void>;
  /** Explicit override; otherwise inferred from the hash* options above so
   *  most tests don't have to think about it — matches how a caller either
   *  passes hashQueue or doesn't. */
  includeHashQueue?: boolean;
  /** Wires the runtime pause gate. Omitted = no gate at all, which is what a
   *  caller that never passes `isPaused` gets. */
  isPaused?: () => boolean;
} = {}) {
  const thumbBacklog = makeBacklog(over.thumbBacklog ?? 0, { sourcePath: over.sourcePath });
  const textBacklog = makeBacklog(over.textBacklog ?? 0, { sourcePath: over.sourcePath });
  const hashBacklog = makeBacklog(over.hashBacklog ?? 0, { sourcePath: over.sourcePath });
  const thumb = makeQueue(over.thumbDepth ?? 0, over.dispatched ?? []);
  const text = makeQueue(over.textDepth ?? 0);
  const hash = makeQueue(over.hashDepth ?? 0);
  const released = over.released ?? [];
  const promotable = new Set(over.promotable ?? []);
  const promotionClaims: string[][] = [];

  if (over.thumbAddBulk) thumb.queue.addBulk = over.thumbAddBulk as never;
  if (over.hashAddBulk) hash.queue.addBulk = over.hashAddBulk as never;

  const repository = {
    claimThumbBatch: thumbBacklog.claim,
    claimTextBatch: textBacklog.claim,
    claimHashBatch: hashBacklog.claim,
    claimThumbByIds: async (userId: string, ids: string[]): Promise<ClaimRow[]> => {
      promotionClaims.push(ids);
      return ids.filter(id => promotable.has(id)).map(id => ({
        id,
        userId,
        storageKey: `k-${id}`,
        sourcePath: over.sourcePath ? over.sourcePath(0) : null,
      }));
    },
    releaseDerivativeClaim: async (kind: "thumb" | "text" | "hash", ids: string[]) => { released.push({ kind, ids }); },
  } as unknown as DerivativeFeederDeps["repository"];

  const includeHashQueue = over.includeHashQueue
    ?? (over.hashBacklog !== undefined || over.hashDepth !== undefined || !!over.hashAddBulk);

  const feeder = createDerivativeFeeder({
    repository,
    thumbQueue: thumb.queue as never,
    textQueue: text.queue as never,
    ...(includeHashQueue ? { hashQueue: hash.queue as never } : {}),
    getAllowedRoots: async () => over.allowedRoots ?? [],
    ...(over.isPaused ? { isPaused: async () => over.isPaused!() } : {}),
    logger,
    highWater: over.highWater ?? 1000,
    lowWater: over.lowWater ?? 200,
  });

  return { feeder, thumb, text, hash, thumbBacklog, textBacklog, hashBacklog, released, promotionClaims };
}

test("feeder: paused feeds nothing and claims nothing", async () => {
  const { feeder, thumb, text, hash, thumbBacklog } = makeFeeder({
    isPaused: () => true,
    thumbBacklog: 30,
    textBacklog: 12,
    hashBacklog: 5,
  });

  assert.deepEqual(await feeder.tick(), { thumb: 0, text: 0, hash: 0 });
  assert.deepEqual([thumb.added.length, text.added.length, hash.added.length], [0, 0, 0]);
  // Claiming is what stamps a row dispatched. A paused tick that still claimed
  // would strand those rows: stamped, with no job to show for it, and the
  // feeder's own claim filter skips them from then on.
  assert.deepEqual(thumbBacklog.claims, [], "no claim issued while paused");
});

test("feeder: reads the pause every tick, so resume needs no restart", async () => {
  let paused = true;
  const { feeder, thumb } = makeFeeder({ thumbBacklog: 30, isPaused: () => paused });

  assert.equal((await feeder.tick()).thumb, 0);
  paused = false;
  // Same feeder instance, no restart: the backlog is untouched and now flows.
  assert.equal((await feeder.tick()).thumb, 30);
  assert.equal(thumb.added.length, 30);
});

test("feeder: pulls both queues up from the database backlog", async () => {
  const { feeder, thumb, text } = makeFeeder({ thumbBacklog: 30, textBacklog: 12 });

  const result = await feeder.tick();

  assert.deepEqual(result, { thumb: 30, text: 12, hash: 0 });
  assert.equal(thumb.added.length, 30);
  assert.equal(text.added.length, 12);
});

test("feeder: does nothing while the queue is above the low water mark", async () => {
  // The gap between the marks is the whole point: without it every tick would
  // top the queue back up to HIGH with a trickle of tiny adds.
  const { feeder, thumb, thumbBacklog } = makeFeeder({
    thumbBacklog: 5000,
    thumbDepth: 900,
    lowWater: 200,
    highWater: 1000,
  });

  const result = await feeder.tick();

  assert.equal(result.thumb, 0);
  assert.equal(thumb.added.length, 0);
  assert.deepEqual(thumbBacklog.claims, [], "a queue above the low mark is not even queried");
});

test("feeder: never puts more in Redis than the high water mark", async () => {
  // The bound is the entire reason this exists — pushing at index time is what
  // left tens of thousands of undrainable jobs sitting in Redis for days.
  const { feeder, thumb } = makeFeeder({
    thumbBacklog: 100_000,
    thumbDepth: 150,
    lowWater: 200,
    highWater: 1000,
  });

  const result = await feeder.tick();

  assert.equal(result.thumb, 850, "tops up to HIGH, not beyond");
  assert.equal(thumb.added.length, 850);
});

test("feeder: claims in bounded chunks rather than one huge statement", async () => {
  const { feeder, thumbBacklog } = makeFeeder({ thumbBacklog: 5000, highWater: 2000, lowWater: 500 });

  await feeder.tick();

  assert.ok(thumbBacklog.claims.length > 1, "the top-up is spread over several claims");
  assert.ok(
    thumbBacklog.claims.every(c => c <= 500),
    `each claim is bounded, got ${thumbBacklog.claims.join(",")}`,
  );
});

test("feeder: an empty backlog is a clean no-op", async () => {
  const { feeder, thumb, text } = makeFeeder();

  const result = await feeder.tick();

  assert.deepEqual(result, { thumb: 0, text: 0, hash: 0 });
  assert.equal(thumb.added.length, 0);
  assert.equal(text.added.length, 0);
});

test("feeder: in-place rows carry the allow-list snapshot", async () => {
  // The worker re-validates a source path against this list; a job fed without
  // it fails its read, so every in-place row the feeder dispatches would break.
  const { feeder, thumb, text } = makeFeeder({
    thumbBacklog: 1,
    textBacklog: 1,
    allowedRoots: ["/nas"],
    sourcePath: n => `/nas/f${n}.pdf`,
  });

  await feeder.tick();

  assert.deepEqual(thumb.added[0].data.allowedRoots, ["/nas"]);
  assert.equal(thumb.added[0].data.sourcePath, "/nas/f0.pdf");
  assert.deepEqual(text.added[0].data.allowedRoots, ["/nas"]);
});

test("feeder: managed rows carry no allow-list", async () => {
  const { feeder, thumb } = makeFeeder({ thumbBacklog: 1, allowedRoots: ["/nas"] });

  await feeder.tick();

  assert.equal(thumb.added[0].data.allowedRoots, undefined, "managed rows read from storage, not disk");
});

test("feeder: releases the claim when the enqueue fails", async () => {
  // The claim already stamped these as dispatched. Left that way they would sit
  // with a stamp and no job until stall detection marked them FAILED — work
  // silently lost because Redis blipped.
  const released: { kind: string; ids: string[] }[] = [];
  const { feeder } = makeFeeder({
    thumbBacklog: 3,
    released,
    thumbAddBulk: async () => { throw new Error("redis down"); },
  });

  const result = await feeder.tick().catch(() => null);

  assert.equal(result, null, "the failure propagates");
  assert.deepEqual(released, [{ kind: "thumb", ids: ["m0", "m1", "m2"] }]);
});

test("feeder: a failing tick does not stop the loop", async () => {
  // Postgres or Redis being briefly unavailable must not permanently halt all
  // derivative processing — there is no other producer left to recover it.
  const { feeder } = makeFeeder({
    thumbBacklog: 1,
    thumbAddBulk: async () => { throw new Error("redis down"); },
  });

  feeder.start();
  await new Promise(resolve => setTimeout(resolve, 10));
  await feeder.stop();

  // Reaching here without an unhandled rejection is the assertion.
  assert.ok(true);
});

test("feeder: stop() prevents any further ticks", async () => {
  const { feeder, thumbBacklog } = makeFeeder({ thumbBacklog: 10_000 });

  await feeder.stop();
  feeder.start();
  await new Promise(resolve => setTimeout(resolve, 20));

  assert.deepEqual(thumbBacklog.claims, [], "a stopped feeder never claims");
});

// ---------------------------------------------------------------------------
// Hash feed (item 15G1)
// ---------------------------------------------------------------------------

test("feeder: hashQueue absent (existing tests, sweep.ts) never claims or feeds hash", async () => {
  const { feeder, hashBacklog, hash } = makeFeeder({ thumbBacklog: 5, includeHashQueue: false });

  const result = await feeder.tick();

  assert.equal(result.hash, 0);
  assert.deepEqual(hashBacklog.claims, [], "no query at all when hashQueue isn't wired");
  assert.equal(hash.added.length, 0);
});

test("feeder: pulls the hash queue up from the database backlog too", async () => {
  const { feeder, hash } = makeFeeder({ hashBacklog: 8 });

  const result = await feeder.tick();

  assert.equal(result.hash, 8);
  assert.equal(hash.added.length, 8);
});

test("feeder: hash respects its own low/high water marks independent of thumb/text", async () => {
  const { feeder, hash, hashBacklog } = makeFeeder({
    hashBacklog: 5000,
    hashDepth: 900, // above the low mark
    thumbBacklog: 100, // thumb still has room, must not affect hash's own gate
    lowWater: 200,
    highWater: 1000,
  });

  const result = await feeder.tick();

  assert.equal(result.hash, 0);
  assert.equal(hash.added.length, 0);
  assert.deepEqual(hashBacklog.claims, [], "a hash queue above its own low mark is not even queried");
});

test("feeder: releases the hash claim when the enqueue fails", async () => {
  const released: { kind: string; ids: string[] }[] = [];
  const { feeder } = makeFeeder({
    hashBacklog: 3,
    released,
    hashAddBulk: async () => { throw new Error("redis down"); },
  });

  const result = await feeder.tick().catch(() => null);

  assert.equal(result, null, "the failure propagates");
  assert.deepEqual(released, [{ kind: "hash", ids: ["m0", "m1", "m2"] }]);
});

// ---------------------------------------------------------------------------
// Viewport promotion (item 15D)
// ---------------------------------------------------------------------------

test("promote: claims backlog rows and adds them lifo", async () => {
  const { feeder, thumb } = makeFeeder({ promotable: ["a", "b"] });

  const result = await feeder.promoteThumbnails("u1", ["a", "b"]);

  assert.deepEqual(result, { queued: 2, reordered: 0 });
  assert.deepEqual(thumb.added.map(j => j.data.mediaId), ["a", "b"]);
  assert.ok(
    thumb.added.every(j => j.opts?.lifo === true),
    "promoted jobs must be lifo, or they queue behind the backlog they were meant to jump",
  );
});

test("promote: reprioritizes ids that already have a job", async () => {
  const { feeder, thumb } = makeFeeder({ promotable: ["a"], dispatched: ["b"] });

  const result = await feeder.promoteThumbnails("u1", ["a", "b"]);

  // "a" was still in the backlog so there was nothing in Redis to reorder;
  // "b" had already been fed, so it is moved rather than re-added.
  assert.deepEqual(result, { queued: 1, reordered: 1 });
  assert.deepEqual(thumb.added.map(j => j.data.mediaId), ["a"]);
  assert.deepEqual(thumb.reprioritized, ["b:true"]);
});

test("promote: ids that are done, dispatched-and-gone, or another user's are no-ops", async () => {
  const { feeder, thumb } = makeFeeder({});

  const result = await feeder.promoteThumbnails("u1", ["ready", "someone-elses"]);

  assert.deepEqual(result, { queued: 0, reordered: 0 });
  assert.equal(thumb.added.length, 0);
  assert.deepEqual(thumb.reprioritized, []);
});

test("promote: ignores the water marks", async () => {
  // Queue already well past HIGH_WATER: the feeder's own tick would refuse to
  // add anything, but the viewport is bounded by the page size and is the
  // work the user is sitting and waiting for.
  const { feeder, thumb } = makeFeeder({
    promotable: ["a"],
    thumbDepth: 5000,
    highWater: 1000,
    lowWater: 200,
  });

  const result = await feeder.promoteThumbnails("u1", ["a"]);

  assert.equal(result.queued, 1);
  assert.deepEqual(thumb.added.map(j => j.data.mediaId), ["a"]);
});

test("promote: an empty viewport does not hit the database", async () => {
  const { feeder, promotionClaims } = makeFeeder({});

  const result = await feeder.promoteThumbnails("u1", []);

  assert.deepEqual(result, { queued: 0, reordered: 0 });
  assert.deepEqual(promotionClaims, []);
});

test("promote: releases the claim when the enqueue throws", async () => {
  const released: { kind: string; ids: string[] }[] = [];
  const { feeder } = makeFeeder({
    promotable: ["a", "b"],
    released,
    thumbAddBulk: async () => { throw new Error("redis down"); },
  });

  await assert.rejects(() => feeder.promoteThumbnails("u1", ["a", "b"]), /redis down/);

  // Otherwise the rows sit stamped-as-dispatched with no job behind them until
  // stall detection gives up on them fifteen minutes later.
  assert.deepEqual(released, [{ kind: "thumb", ids: ["a", "b"] }]);
});
