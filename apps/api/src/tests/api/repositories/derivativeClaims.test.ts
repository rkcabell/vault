/**
 * The by-id promotion claims, run against a real Postgres.
 *
 * Same reason as sourcePathPrefix.test.ts: the defect these cover is a missing
 * predicate in raw SQL, so every mock of MediaRepository passes with it absent.
 * Skips loudly when no database is reachable.
 */
import test, { after, describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient, type Prisma } from "@prisma/client";
import { MediaRepository } from "@/repositories/mediaRepository.js";

const prisma = new PrismaClient();

const reachable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const skip = reachable ? false : "no Postgres on POSTGRES_URL — set one up to run this";

const repo = new MediaRepository(prisma);
const tag = randomUUID().slice(0, 8);
const userIds: string[] = [];

/** The columns a fixture varies; everything else is a claimable default. */
type Fixture = { filename: string } & Partial<Prisma.MediaCreateManyInput>;

/** A user owning one row per `rows` entry, keyed by the entry's filename. */
async function seed (rows: Fixture[]): Promise<string> {
  const user = await prisma.user.create({
    data: { email: `claim-test-${tag}-${userIds.length}@example.invalid`, passwordHash: "x" },
  });
  userIds.push(user.id);
  await prisma.media.createMany({
    data: rows.map(({ filename, ...overrides }) => ({
      userId: user.id,
      filename,
      sourcePath: `E:\\vault-${tag}\\${filename}`,
      title: filename,
      mimeType: "application/pdf",
      sizeBytes: 1234,
      sourceState: "READY" as const,
      ...overrides,
    })),
  });
  return user.id;
}

/** Filenames of the claimed rows, sorted. */
async function names (claimed: { id: string }[]): Promise<string[]> {
  const rows = await prisma.media.findMany({
    where: { id: { in: claimed.map(r => r.id) } },
    select: { filename: true },
  });
  return rows.map(r => r.filename).sort();
}

const withStrictOrder = async <T>(fn: () => Promise<T>): Promise<T> => {
  const previous = process.env.DEDUP_STRICT_ORDER;
  process.env.DEDUP_STRICT_ORDER = "true";
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.DEDUP_STRICT_ORDER;
    else process.env.DEDUP_STRICT_ORDER = previous;
  }
};

after(async () => {
  if (userIds.length > 0) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

describe("by-id derivative claims", { skip }, () => {
  test("claimThumbByIds takes only eligible rows", async () => {
    const userId = await seed([
      { filename: "waiting.pdf" },
      { filename: "dispatched.pdf", thumbQueuedAt: new Date() },
      { filename: "done.pdf", thumbState: "READY" },
      { filename: "not-ready.pdf", sourceState: "PENDING" },
      { filename: "missing.pdf", missingSince: new Date() },
    ]);
    const ids = await prisma.media.findMany({ where: { userId }, select: { id: true } });

    const claimed = await repo.claimThumbByIds(userId, ids.map(r => r.id));
    assert.deepEqual(await names(claimed), ["waiting.pdf"]);
  });

  test("claimTextByIds takes only eligible rows", async () => {
    const userId = await seed([
      { filename: "waiting.pdf" },
      { filename: "dispatched.pdf", textQueuedAt: new Date() },
      { filename: "done.pdf", textState: "READY" },
      { filename: "not-ready.pdf", sourceState: "PENDING" },
      { filename: "missing.pdf", missingSince: new Date() },
    ]);
    const ids = await prisma.media.findMany({ where: { userId }, select: { id: true } });

    const claimed = await repo.claimTextByIds(userId, ids.map(r => r.id));
    assert.deepEqual(await names(claimed), ["waiting.pdf"]);
  });

  test("another user's ids claim nothing", async () => {
    const mine = await seed([{ filename: "mine.pdf" }]);
    const theirs = await seed([{ filename: "theirs.pdf" }]);
    const theirIds = await prisma.media.findMany({ where: { userId: theirs }, select: { id: true } });

    assert.deepEqual(await repo.claimThumbByIds(mine, theirIds.map(r => r.id)), []);
    assert.deepEqual(await repo.claimTextByIds(mine, theirIds.map(r => r.id)), []);
  });

  // The regression this file exists for: promotion spelled its WHERE out inline
  // and so walked rows straight past the barrier the flag exists to enforce,
  // while countTextBacklogAhead (built on the shared fragment) still honoured it.
  test("DEDUP_STRICT_ORDER holds promotion back until the row's hash lands", async () => {
    const userId = await seed([
      { filename: "hash-pending.pdf", hashState: "PENDING" },
      { filename: "hash-ready.pdf", hashState: "READY" },
      // A hash that failed still lets the derivative run — it only loses dedup.
      { filename: "hash-failed.pdf", hashState: "FAILED" },
    ]);
    const ids = (await prisma.media.findMany({ where: { userId }, select: { id: true } })).map(r => r.id);

    const thumbs = await withStrictOrder(() => repo.claimThumbByIds(userId, ids));
    assert.deepEqual(await names(thumbs), ["hash-failed.pdf", "hash-ready.pdf"]);

    const texts = await withStrictOrder(() => repo.claimTextByIds(userId, ids));
    assert.deepEqual(await names(texts), ["hash-failed.pdf", "hash-ready.pdf"]);

    // Flag off, the same row is claimable — the gate is the flag, not the state.
    await prisma.media.updateMany({ where: { userId }, data: { thumbQueuedAt: null, textQueuedAt: null } });
    const ungated = await repo.claimThumbByIds(userId, ids);
    assert.equal(ungated.length, 3);
  });
});

if (skip) console.warn(`\n  SKIPPED derivativeClaims.test.ts — ${skip}\n`);
