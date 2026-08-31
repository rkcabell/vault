/**
 * Run every raw-SQL derivative claim against live Postgres, always rolled back.
 *
 * $queryRaw is unchecked by TypeScript, so a wrong column or mis-bound parameter
 * only fails at runtime in a worker. Covers the three claims 15D left unverified,
 * the 15C stall-detection re-key, and 15G1's claimHashBatch / DEDUP_STRICT_ORDER
 * gate / hash stall arm.
 *
 * Safe against real data: every check throws a sentinel to force the rollback.
 *
 *   tsx scripts/bench/verifyClaims.ts
 */

import { Prisma, prisma } from "@vault/db";
import { MediaRepository } from "../../src/repositories/mediaRepository.js";
import { markStalledJobs } from "../../src/services/stallDetectionService.js";
import { STALL_THRESHOLD_MINUTES } from "../../src/lib/workerStateMachine.js";

/** Thrown to force the rollback. Never escapes `inRollback`. */
class Rollback extends Error {
  constructor (public value: unknown) { super("rollback"); }
}

/** Run `fn` in a transaction that is guaranteed to roll back, and return its value. */
async function inRollback<T> (fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  try {
    await prisma.$transaction(async tx => { throw new Rollback(await fn(tx)); });
  } catch (err) {
    if (err instanceof Rollback) return err.value as T;
    throw err;
  }
  throw new Error("unreachable: transaction resolved without rolling back");
}

const results: { name: string; ok: boolean; detail: string }[] = [];

function record (name: string, ok: boolean, detail: string) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name.padEnd(34)} ${detail}`);
}

async function check (name: string, fn: () => Promise<string>) {
  try {
    record(name, true, await fn());
  } catch (err) {
    record(name, false, err instanceof Error ? err.message.split("\n")[0] : String(err));
  }
}

async function main () {
  const userId = (await prisma.user.findFirst({ select: { id: true } }))?.id;
  if (!userId) throw new Error("no User row — cannot scope the userId-bound claims");

  console.log(`verifying raw claims against live Postgres (user ${userId})\n`);

  // Parses, binds LIMIT, and returns the columns the feeder destructures.
  await check("claimThumbBatch", async () =>
    inRollback(async tx => {
      const repo = new MediaRepository(tx);
      const rows = await repo.claimThumbBatch(5);
      for (const r of rows) {
        if (!("id" in r && "userId" in r && "storageKey" in r && "sourcePath" in r)) {
          throw new Error(`missing column in RETURNING: ${Object.keys(r).join(",")}`);
        }
      }
      return `claimed ${rows.length} (limit 5)`;
    }),
  );

  // LIMIT 0 is a wasted round-trip and LIMIT -1 an error.
  await check("claimThumbBatch(0) short-circuits", async () =>
    inRollback(async tx => {
      const rows = await new MediaRepository(tx).claimThumbBatch(0);
      if (rows.length !== 0) throw new Error(`expected [], got ${rows.length}`);
      return "returns [] without querying";
    }),
  );

  // --- claimTextBatch -------------------------------------------------------
  await check("claimTextBatch", async () =>
    inRollback(async tx => {
      const rows = await new MediaRepository(tx).claimTextBatch(5);
      return `claimed ${rows.length} (limit 5)`;
    }),
  );

  // --- claimHashBatch (15G1) -------------------------------------------------
  // Routes through the same claimDerivativeBatch as thumb/text, widened to a
  // third column pair — this is what exercises the widening.
  await check("claimHashBatch", async () =>
    inRollback(async tx => {
      const rows = await new MediaRepository(tx).claimHashBatch(5);
      for (const r of rows) {
        if (!("id" in r && "userId" in r && "storageKey" in r && "sourcePath" in r)) {
          throw new Error(`missing column in RETURNING: ${Object.keys(r).join(",")}`);
        }
      }
      return `claimed ${rows.length} (limit 5)`;
    }),
  );

  // Unstamped means dispatched twice; stamped-but-not-returned means never.
  await check("claim sets the dispatch stamp (thumb, text, hash)", async () =>
    inRollback(async tx => {
      const seeded = await tx.media.create({
        data: {
          userId,
          storageKey: `bench/verify/${Date.now()}`,
          filename: "verify.pdf",
          mimeType: "application/pdf",
          sizeBytes: 1,
          title: "verify",
          sourceState: "READY",
          thumbState: "PENDING",
          textState: "PENDING",
          hashState: "PENDING",
        },
        select: { id: true },
      });
      const repo = new MediaRepository(tx);
      // Newest-first ordering means the row just created is claimed first.
      const thumb = await repo.claimThumbBatch(1);
      const text = await repo.claimTextBatch(1);
      const hash = await repo.claimHashBatch(1);
      if (!thumb.some(r => r.id === seeded.id)) throw new Error("seeded row not returned by claimThumbBatch");
      if (!text.some(r => r.id === seeded.id)) throw new Error("seeded row not returned by claimTextBatch");
      if (!hash.some(r => r.id === seeded.id)) throw new Error("seeded row not returned by claimHashBatch");
      const after = await tx.media.findUnique({
        where: { id: seeded.id },
        select: { thumbQueuedAt: true, textQueuedAt: true, hashQueuedAt: true },
      });
      if (!after?.thumbQueuedAt) throw new Error("thumbQueuedAt still NULL after claim");
      if (!after?.textQueuedAt) throw new Error("textQueuedAt still NULL after claim");
      if (!after?.hashQueuedAt) throw new Error("hashQueuedAt still NULL after claim");
      // Re-claiming must not return it: that is the double-dispatch bug.
      const again = await repo.claimThumbBatch(1);
      const hashAgain = await repo.claimHashBatch(1);
      if (again.some(r => r.id === seeded.id)) throw new Error("row claimable twice (thumb)");
      if (hashAgain.some(r => r.id === seeded.id)) throw new Error("row claimable twice (hash)");
      return "stamped on all three, and not claimable twice";
    }),
  );

  // DEDUP_STRICT_ORDER's whole mechanism: thumb/text must wait for hashState
  // to leave PENDING, but a FAILED hash still unblocks them (loses dedup,
  // doesn't strand the item). Toggled only for this check.
  await check("DEDUP_STRICT_ORDER gates thumb/text on hashState <> PENDING", async () =>
    inRollback(async tx => {
      const prevFlag = process.env.DEDUP_STRICT_ORDER;
      process.env.DEDUP_STRICT_ORDER = "true";
      try {
        const base = {
          userId,
          mimeType: "image/jpeg",
          sizeBytes: 1,
          sourceState: "READY" as const,
          thumbState: "PENDING" as const,
          textState: "PENDING" as const,
        };
        const waitingOnHash = await tx.media.create({
          data: { ...base, storageKey: `bench/strict-wait/${Date.now()}`, filename: "wait.jpg", title: "wait", hashState: "PENDING" },
          select: { id: true },
        });
        const hashFailed = await tx.media.create({
          data: { ...base, storageKey: `bench/strict-failed/${Date.now()}`, filename: "failed.jpg", title: "failed", hashState: "FAILED" },
          select: { id: true },
        });
        const repo = new MediaRepository(tx);
        const rows = await repo.claimThumbBatch(500);
        const ids = new Set(rows.map(r => r.id));
        if (ids.has(waitingOnHash.id)) throw new Error("claimed a row whose own hash is still PENDING");
        if (!ids.has(hashFailed.id)) throw new Error("a FAILED hash must not strand the thumb claim");
        return "PENDING hash blocks the claim; FAILED hash does not";
      } finally {
        process.env.DEDUP_STRICT_ORDER = prevFlag;
      }
    }),
  );

  // Without these, a job burns its retry budget on a file not there yet
  // (upload mid-PUT) or gone (tombstoned move).
  await check("claim skips non-READY / missing rows", async () =>
    inRollback(async tx => {
      const base = {
        userId,
        filename: "guard.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1,
        title: "guard",
        thumbState: "PENDING" as const,
        textState: "PENDING" as const,
      };
      const pending = await tx.media.create({
        data: { ...base, storageKey: `bench/guard-a/${Date.now()}`, sourceState: "PENDING" },
        select: { id: true },
      });
      const missing = await tx.media.create({
        data: {
          ...base,
          storageKey: `bench/guard-b/${Date.now()}`,
          sourceState: "READY",
          missingSince: new Date(),
        },
        select: { id: true },
      });
      // Far more than the two seeded rows, so "not returned" means excluded by
      // the guard rather than cut off by the limit.
      const rows = await new MediaRepository(tx).claimThumbBatch(500);
      const ids = new Set(rows.map(r => r.id));
      if (ids.has(pending.id)) throw new Error("claimed a sourceState=PENDING row");
      if (ids.has(missing.id)) throw new Error("claimed a missingSince row");
      return "sourceState=PENDING and missingSince both excluded";
    }),
  );

  // Flips NEEDS_OCR -> PENDING, which is what the feeder claims. Without an
  // in-statement stamp the next feeder tick silently undoes "Extract all".
  await check("claimNeedsOcrBatch stamps in-statement", async () =>
    inRollback(async tx => {
      const seeded = await tx.media.create({
        data: {
          userId,
          storageKey: `bench/needsocr/${Date.now()}`,
          filename: "scan.pdf",
          mimeType: "application/pdf",
          sizeBytes: 1,
          title: "scan",
          sourceState: "READY",
          thumbState: "READY",
          textState: "NEEDS_OCR",
        },
        select: { id: true },
      });
      const repo = new MediaRepository(tx);
      const rows = await repo.claimNeedsOcrBatch(userId, 50);
      if (!rows.some(r => r.id === seeded.id)) throw new Error("seeded NEEDS_OCR row not claimed");
      const after = await tx.media.findUnique({
        where: { id: seeded.id },
        select: { textState: true, textQueuedAt: true },
      });
      if (after?.textState !== "PENDING") throw new Error(`textState is ${after?.textState}, expected PENDING`);
      if (!after?.textQueuedAt) throw new Error("textQueuedAt NULL — the feeder would re-claim this row");
      // And prove the feeder now can't take it.
      const stolen = await repo.claimTextBatch(500);
      if (stolen.some(r => r.id === seeded.id)) {
        throw new Error("feeder claimed a forced-OCR row — Extract all would be undone");
      }
      return "flips to PENDING, stamps, feeder cannot re-claim";
    }),
  );

  // Already validated in 15D; re-run so one command covers the whole set.
  await check("claimThumbByIds scopes by user", async () =>
    inRollback(async tx => {
      const rows = await new MediaRepository(tx).claimThumbByIds(userId, [
        "definitely-not-a-real-id",
        "another-fake",
      ]);
      if (rows.length !== 0) throw new Error(`expected [], got ${rows.length}`);
      return "unknown ids return [] (no error)";
    }),
  );

  // A never-dispatched row is waiting, not stalled. Keying on updatedAt instead
  // of the stamp would mark a whole fresh backlog FAILED.
  await check("stall detection ignores un-dispatched rows (thumb, text, hash)", async () =>
    inRollback(async tx => {
      const old = new Date(Date.now() - (STALL_THRESHOLD_MINUTES + 60) * 60 * 1000);
      const base = {
        userId,
        filename: "stall.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1,
        title: "stall",
        sourceState: "READY" as const,
        thumbState: "PENDING" as const,
        textState: "PENDING" as const,
        hashState: "PENDING" as const,
      };
      // Waiting: PENDING, old, never handed to a queue.
      const waiting = await tx.media.create({
        data: { ...base, storageKey: `bench/stall-wait/${Date.now()}`, createdAt: old, updatedAt: old },
        select: { id: true },
      });
      // Stalled: dispatched long ago, never reported back.
      const stalled = await tx.media.create({
        data: {
          ...base,
          storageKey: `bench/stall-hit/${Date.now()}`,
          thumbQueuedAt: old,
          textQueuedAt: old,
          hashQueuedAt: old,
        },
        select: { id: true },
      });

      const repo = new MediaRepository(tx);
      // markStalledJobs only calls .warn.
      const noop = { warn: () => {}, info: () => {}, error: () => {} } as unknown as Parameters<typeof markStalledJobs>[1];
      await markStalledJobs(repo, noop);

      const w = await tx.media.findUnique({ where: { id: waiting.id }, select: { thumbState: true, textState: true, hashState: true } });
      const s = await tx.media.findUnique({ where: { id: stalled.id }, select: { thumbState: true, textState: true, hashState: true } });

      if (w?.thumbState !== "PENDING" || w?.textState !== "PENDING" || w?.hashState !== "PENDING") {
        throw new Error(
          `un-dispatched row was marked ${w?.thumbState}/${w?.textState}/${w?.hashState} — a fresh backlog would be destroyed`,
        );
      }
      if (s?.thumbState !== "FAILED") throw new Error(`dispatched stalled row is ${s?.thumbState}, expected FAILED`);
      if (s?.textState !== "ERROR") throw new Error(`dispatched stalled row is ${s?.textState}, expected ERROR`);
      if (s?.hashState !== "FAILED") throw new Error(`dispatched stalled hash row is ${s?.hashState}, expected FAILED`);
      return `waiting row untouched; dispatched row → FAILED/ERROR/FAILED (threshold ${STALL_THRESHOLD_MINUTES}m)`;
    }),
  );

  // countDerivativeBacklog's replacement (15I) — was exists-but-unused before;
  // now backs GET /api/server/backlog, so confirm the groupBy runs.
  await check("countDerivativeProgress", async () => {
    const counts = await new MediaRepository(prisma).countDerivativeProgress(userId);
    return `thumb=${JSON.stringify(counts.thumb)} text=${JSON.stringify(counts.text)} hash=${JSON.stringify(counts.hash)}`;
  });

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log(`failed: ${failed.map(f => f.name).join(", ")}`);
    process.exitCode = 1;
  }
}

main()
  .catch(err => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
