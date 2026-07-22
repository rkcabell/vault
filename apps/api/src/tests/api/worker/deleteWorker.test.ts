import test from "node:test";
import assert from "node:assert/strict";
import { createDeleteProcessor } from "@/worker/deleteWorker.js";
import type { MediaDeletionRow } from "@/repositories/mediaRepository.js";

function makeLogger () {
  return { info: () => {}, warn: () => {} };
}

type DepCalls = {
  deletedIds: string[];
  coverClears: string[][];
  storageKeys: string[];
  reconcileCount: number;
};

/** Build worker deps over an in-memory set of rows. listMediaForDeletion returns
 *  the next chunk and deleteMediaByIds removes them, simulating "deleted rows drop
 *  out of the filter" so the re-select loop terminates. */
function makeDeps (rows: MediaDeletionRow[], opts: { readAbortEpoch?: () => Promise<number> } = {}) {
  const remaining = [...rows];
  const calls: DepCalls = { deletedIds: [], coverClears: [], storageKeys: [], reconcileCount: 0 };
  const byId = new Map(rows.map(r => [r.id, r] as const));

  const mediaRepository = {
    countMediaForDeletion: async () => rows.length,
    listMediaForDeletion: async (_filters: unknown, limit: number) => remaining.slice(0, limit),
    findMediaForDeletionByIds: async (_userId: string, ids: string[]) =>
      ids.map(id => byId.get(id)).filter((r): r is MediaDeletionRow => !!r),
    deleteMediaByIds: async (ids: string[]) => {
      calls.deletedIds.push(...ids);
      for (const id of ids) {
        const idx = remaining.findIndex(r => r.id === id);
        if (idx >= 0) remaining.splice(idx, 1);
      }
      return ids.length;
    },
    reconcileTagCounts: async () => { calls.reconcileCount++; },
  };

  const bundleRepository = {
    clearCoverMediaForIds: async (_userId: string, ids: string[]) => { calls.coverClears.push(ids); },
  };

  const storage = {
    deleteIfPresent: async ({ key }: { bucket: string; key: string }) => { calls.storageKeys.push(key); },
  };

  return { deps: { mediaRepository, bundleRepository, storage, bucket: "b", logger: makeLogger(), ...opts } as any, calls };
}

function makeJob (data: { userId: string; ids?: string[]; filters?: object }) {
  return { data, updateProgress: async () => {} } as any;
}

function row (id: string, over: Partial<MediaDeletionRow> = {}): MediaDeletionRow {
  return { id, storageKey: `${id}/orig`, thumbnailKey: `thumbs/${id}.webp`, sourcePath: null, ...over };
}

test("filter mode: re-selects in chunks until empty, reconciles tags once", async () => {
  const rows = [row("a"), row("b"), row("c"), row("d"), row("e")];
  const { deps, calls } = makeDeps(rows);
  const processor = createDeleteProcessor({ ...deps, chunkSize: 2 });

  const result = await processor(makeJob({ userId: "u1", filters: {} })) as { total: number; deleted: number };

  assert.equal(result.deleted, 5);
  assert.equal(result.total, 5);
  assert.deepEqual(calls.deletedIds.sort(), ["a", "b", "c", "d", "e"]);
  // One reconcile pass total, not one per chunk.
  assert.equal(calls.reconcileCount, 1);
  // 3 chunks (2 + 2 + 1) → 3 cover-clear calls.
  assert.equal(calls.coverClears.length, 3);
});

test("ids mode: deletes the given ids and counts total from the list length", async () => {
  const rows = [row("a"), row("b"), row("c")];
  const { deps, calls } = makeDeps(rows);
  const processor = createDeleteProcessor({ ...deps, chunkSize: 10 });

  const result = await processor(makeJob({ userId: "u1", ids: ["a", "b", "c"] })) as { total: number; deleted: number };

  assert.equal(result.total, 3);
  assert.equal(result.deleted, 3);
  assert.deepEqual(calls.deletedIds.sort(), ["a", "b", "c"]);
  assert.equal(calls.reconcileCount, 1);
});

test("in-place items (sourcePath set): never unlink the source, only the thumbnail", async () => {
  const rows = [
    row("a", { sourcePath: "/drive/a.pdf" }),         // in-place: skip storageKey
    row("b", { sourcePath: null }),                   // managed: unlink storageKey
    row("c", { sourcePath: "/drive/c.png", thumbnailKey: null }), // in-place, no thumb
  ];
  const { deps, calls } = makeDeps(rows);
  const processor = createDeleteProcessor({ ...deps, chunkSize: 10 });

  await processor(makeJob({ userId: "u1", ids: ["a", "b", "c"] }));

  // Never the in-place sources.
  assert.ok(!calls.storageKeys.includes("a/orig"));
  assert.ok(!calls.storageKeys.includes("c/orig"));
  // Managed original is removed; thumbnails for a and b are removed; c has none.
  assert.ok(calls.storageKeys.includes("b/orig"));
  assert.ok(calls.storageKeys.includes("thumbs/a.webp"));
  assert.ok(calls.storageKeys.includes("thumbs/b.webp"));
  assert.ok(!calls.storageKeys.includes("thumbs/c.webp"));
});

test("abort mid-run: stops between chunks, reports aborted with partial count", async () => {
  const rows = [row("a"), row("b"), row("c"), row("d")];
  // Epoch: 0 at start and for the first chunk's pre-check, then bumps to 1.
  let reads = 0;
  const readAbortEpoch = async () => (reads++ < 2 ? 0 : 1);
  const { deps, calls } = makeDeps(rows, { readAbortEpoch });
  const processor = createDeleteProcessor({ ...deps, chunkSize: 2 });

  const result = await processor(makeJob({ userId: "u1", filters: {} })) as { aborted?: boolean; deleted: number };

  assert.equal(result.aborted, true);
  assert.equal(result.deleted, 2); // only the first chunk
  // Reconcile still runs for what was deleted.
  assert.equal(calls.reconcileCount, 1);
});

test("nothing matched: no reconcile, no deletes", async () => {
  const { deps, calls } = makeDeps([]);
  const processor = createDeleteProcessor(deps);

  const result = await processor(makeJob({ userId: "u1", filters: {} })) as { deleted: number; total: number };

  assert.equal(result.deleted, 0);
  assert.equal(result.total, 0);
  assert.equal(calls.reconcileCount, 0);
  assert.equal(calls.deletedIds.length, 0);
});
