import test from "node:test";
import assert from "node:assert/strict";
import { createDedupService } from "@/services/media/dedupService.js";

function makeMember (id: string, contentHash: string, opts: { sizeBytes?: number; sourcePath?: string | null } = {}) {
  return {
    id,
    title: id,
    filename: `${id}.jpg`,
    mimeType: "image/jpeg",
    sizeBytes: opts.sizeBytes ?? 100,
    sourcePath: opts.sourcePath ?? null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    thumbState: "READY",
    thumbnailKey: null,
    contentHash,
  };
}

function makeDeps (opts: {
  members?: ReturnType<typeof makeMember>[];
  unhashedCount?: number;
  unhashedPages?: Array<Array<{ id: string; storageKey: string; sourcePath: string | null }>>;
  allowedRoots?: string[];
} = {}) {
  const enqueued: Array<Array<{ data: { mediaId: string; allowedRoots?: string[] } }>> = [];
  const pages = [...(opts.unhashedPages ?? [])];

  const deps = {
    repository: {
      listDuplicateMembers: async () => opts.members ?? [],
      countUnhashed: async () => opts.unhashedCount ?? 0,
      listUnhashedPage: async () => pages.shift() ?? [],
    },
    hashQueue: {
      addBulk: async (jobs: Array<{ data: { mediaId: string; allowedRoots?: string[] } }>) => {
        enqueued.push(jobs);
        return [];
      },
    } as never,
    getAllowedRoots: async () => opts.allowedRoots ?? [],
    logger: { info: () => {} } as never,
  };

  return { deps, enqueued };
}

test("dedup: groups members by hash, biggest reclaimable space first", async () => {
  const t = makeDeps({
    members: [
      // hash A: 2 small copies → 100 reclaimable
      makeMember("a1", "hashA", { sizeBytes: 100 }),
      makeMember("a2", "hashA", { sizeBytes: 100 }),
      // hash B: 3 large copies → 4000 reclaimable
      makeMember("b1", "hashB", { sizeBytes: 2000, sourcePath: "/nas/b.jpg" }),
      makeMember("b2", "hashB", { sizeBytes: 2000 }),
      makeMember("b3", "hashB", { sizeBytes: 2000 }),
    ],
    unhashedCount: 7,
  });

  const result = await createDedupService(t.deps).listDuplicateGroups("u1");

  assert.equal(result.unhashedCount, 7);
  assert.deepEqual(result.groups.map(g => g.contentHash), ["hashB", "hashA"]);
  assert.deepEqual(result.groups[0].items.map(i => i.id), ["b1", "b2", "b3"]);
  // contentHash lives on the group, not repeated per item.
  assert.equal("contentHash" in result.groups[0].items[0], false);
});

test("dedup: scan pages through unhashed rows and enqueues hash jobs", async () => {
  const t = makeDeps({
    unhashedPages: [
      [
        { id: "m1", storageKey: "k1", sourcePath: "/nas/a.pdf" },
        { id: "m2", storageKey: "k2", sourcePath: null },
      ],
      [{ id: "m3", storageKey: "k3", sourcePath: null }],
    ],
    allowedRoots: ["/nas"],
  });

  const result = await createDedupService(t.deps).startScan("u1");

  assert.deepEqual(result, { ok: true, queued: 3 });
  assert.equal(t.enqueued.length, 2); // one addBulk per page
  const jobs = t.enqueued.flat().map(j => j.data);
  assert.deepEqual(jobs.map(j => j.mediaId), ["m1", "m2", "m3"]);
  // Allowed roots snapshotted into every job (needed for in-place reads).
  assert.deepEqual(jobs[0].allowedRoots, ["/nas"]);
});

test("dedup: no unhashed rows → nothing enqueued", async () => {
  const t = makeDeps({});

  const result = await createDedupService(t.deps).startScan("u1");

  assert.deepEqual(result, { ok: true, queued: 0 });
  assert.deepEqual(t.enqueued, []);
});
