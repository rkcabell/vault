/**
 * The two source-path prefix queries, run against a real Postgres.
 *
 * These cannot be faked: the bug they cover lived entirely in the SQL Prisma
 * generated (`LIKE 'E:\root\%'`, which Postgres reads as an escape sequence and
 * a literal percent), so every mock of MediaRepository passes with it present.
 * Skips loudly when no database is reachable rather than failing a machine
 * without one.
 */
import test, { after, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { MediaRepository } from "@/repositories/mediaRepository.js";

const prisma = new PrismaClient();

const reachable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const skip = reachable ? false : "no Postgres on POSTGRES_URL — set one up to run this";

const repo = new MediaRepository(prisma);
const tag = randomUUID().slice(0, 8);
const userIds: string[] = [];

/** A user owning `paths`, all in-place (storageKey null, per the XOR constraint). */
async function seed (paths: string[]): Promise<string> {
  const user = await prisma.user.create({
    data: { email: `prefix-test-${tag}-${userIds.length}@example.invalid`, passwordHash: "x" },
  });
  userIds.push(user.id);
  await prisma.media.createMany({
    data: paths.map(sourcePath => ({
      userId: user.id,
      sourcePath,
      filename: sourcePath.split(/[\\/]/).pop()!,
      title: sourcePath.split(/[\\/]/).pop()!,
      mimeType: "application/pdf",
      sizeBytes: 1234,
      sourceMtimeMs: 1700000000000,
    })),
  });
  return user.id;
}

/** The basenames the query matched, sorted — paths are long, mismatches aren't. */
const names = (paths: string[]) => paths.map(p => p.split(/[\\/]/).pop()!).sort();

after(async () => {
  if (userIds.length > 0) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

describe("sourcePath prefix queries", { skip }, () => {
  test("Windows path: every row under the root, and nothing beside it", async () => {
    const root = `E:\\vault-${tag}\\lib\\`;
    const under = [`${root}a.pdf`, `${root}sub\\b.pdf`, `${root}sub\\deep\\c.pdf`];
    const userId = await seed([
      ...under,
      // Sibling whose name extends the root's last segment — the case the
      // trailing separator exists for.
      `E:\\vault-${tag}\\library-other\\d.pdf`,
      `E:\\vault-${tag}\\e.pdf`,
    ]);

    const entries = await repo.listReconcileEntries(userId, root);
    assert.deepEqual(names(entries.map(e => e.sourcePath)), names(under));

    const ids = await repo.findIdsBySourcePathPrefix(userId, root);
    assert.equal(ids.length, 3);
  });

  test("POSIX path: unaffected by the fix", async () => {
    const root = `/srv/vault-${tag}/lib/`;
    const under = [`${root}a.pdf`, `${root}sub/b.pdf`];
    const userId = await seed([...under, `/srv/vault-${tag}/library-other/d.pdf`]);

    const entries = await repo.listReconcileEntries(userId, root);
    assert.deepEqual(names(entries.map(e => e.sourcePath)), names(under));
    assert.equal((await repo.findIdsBySourcePathPrefix(userId, root)).length, 2);
  });

  test("a root given without a trailing separator still matches its contents", async () => {
    const root = path.join(path.sep === "\\" ? "E:\\" : "/", `vault-${tag}`, "lib");
    const under = [path.join(root, "a.pdf"), path.join(root, "sub", "b.pdf")];
    const userId = await seed([...under, path.join(`${root}-other`, "d.pdf")]);

    assert.equal((await repo.listReconcileEntries(userId, root)).length, 2);
    assert.equal((await repo.findIdsBySourcePathPrefix(userId, root)).length, 2);
  });

  test("`_` and `%` in a directory name are literals, not wildcards", async () => {
    const base = `E:\\vault-${tag}`;
    const userId = await seed([
      `${base}\\a_b\\hit.pdf`,
      `${base}\\aXb\\miss.pdf`,
      `${base}\\100%\\hit.pdf`,
      `${base}\\100pct\\miss.pdf`,
    ]);

    for (const dir of ["a_b", "100%"]) {
      const entries = await repo.listReconcileEntries(userId, `${base}\\${dir}\\`);
      assert.deepEqual(names(entries.map(e => e.sourcePath)), ["hit.pdf"], dir);
      assert.equal((await repo.findIdsBySourcePathPrefix(userId, `${base}\\${dir}\\`)).length, 1, dir);
    }
  });

  test("another user's rows under the same root are not returned", async () => {
    const root = `E:\\vault-${tag}-shared\\`;
    const mine = await seed([`${root}mine.pdf`]);
    await seed([`${root}theirs.pdf`]);

    const entries = await repo.listReconcileEntries(mine, root);
    assert.deepEqual(names(entries.map(e => e.sourcePath)), ["mine.pdf"]);
    assert.equal((await repo.findIdsBySourcePathPrefix(mine, root)).length, 1);
  });

  test("listReconcileEntries maps every column the sweep reads", async () => {
    const root = `E:\\vault-${tag}-cols\\`;
    const userId = await seed([`${root}only.pdf`]);
    const missingSince = new Date("2026-07-30T12:00:00.000Z");
    await prisma.media.updateMany({ where: { userId }, data: { missingSince, fileDate: missingSince } });

    const [entry] = await repo.listReconcileEntries(userId, root);
    assert.equal(entry.sourcePath, `${root}only.pdf`);
    assert.equal(entry.mimeType, "application/pdf");
    assert.equal(entry.storageKey, null);
    assert.equal(entry.sizeBytes, 1234);
    // Renamed on the way out: the column is sourceMtimeMs, the field is mtimeMs.
    assert.equal(entry.mtimeMs, 1700000000000);
    assert.deepEqual(entry.fileDate, missingSince);
    assert.deepEqual(entry.missingSince, missingSince);
    assert.ok(entry.id.length > 0);
  });
});

if (skip) console.warn(`\n  SKIPPED sourcePathPrefix.test.ts — ${skip}\n`);
