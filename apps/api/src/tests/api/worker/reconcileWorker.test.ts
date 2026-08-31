import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import type { Job } from "bullmq";
import type { Prisma } from "@prisma/client";
import { createReconcileProcessor } from "@/worker/reconcileWorker.js";
import type { ReconcileJobData, ReconcileJobProgress } from "@/queues/enqueueReconcile.js";
import type { DiscoveredFile } from "@/worker/indexCore.js";

const ROOT = path.resolve("reconcile-root");
const p = (...segs: string[]) => path.join(ROOT, ...segs);

/** A stored Media row, trimmed to the columns reconcile reads or writes. */
type Row = {
  id: string;
  sourcePath: string;
  filename: string;
  title: string;
  mimeType: string;
  storageKey: string;
  sizeBytes: number;
  mtimeMs: number | null;
  fileDate: Date | null;
  contentHash: string | null;
  titleIsUserEdited: boolean;
  missingSince: Date | null;
  thumbState: string;
  textState: string;
  hashState: string;
  /** NULL = waiting in the DB backlog for the feeder; set = already dispatched. */
  thumbQueuedAt: Date | null;
  textQueuedAt: Date | null;
  hashQueuedAt: Date | null;
};

function makeRow (over: Partial<Row> & Pick<Row, "id" | "sourcePath">): Row {
  const base = path.basename(over.sourcePath);
  return {
    filename: base,
    title: base.replace(/\.[^.]+$/, ""),
    mimeType: "image/jpeg",
    storageKey: `external/u1/${over.id}/${base}`,
    sizeBytes: 100,
    mtimeMs: 1000,
    fileDate: null,
    contentHash: null,
    titleIsUserEdited: false,
    missingSince: null,
    thumbState: "READY",
    textState: "READY",
    // Default mimeType (image/jpeg) is renderable, so a settled row's hash
    // arrived inline from the thumb worker — UNSUPPORTED means "no job
    // needed", not "unhashed" (see hashState in schema.prisma).
    hashState: "UNSUPPORTED",
    thumbQueuedAt: null,
    textQueuedAt: null,
    hashQueuedAt: null,
    ...over,
  };
}

/** A file as the walk would report it. */
function makeFile (absPath: string, size = 100, mtimeMs = 1000): DiscoveredFile {
  return { absPath, name: path.basename(absPath), size, mtimeMs };
}

type StatStub = { size: number; mtimeMs: number; isSymbolicLink?: () => boolean };

type Options = {
  rows?: Row[];
  /** Files the walk finds on disk. */
  onDisk?: DiscoveredFile[];
  /** Paths that exist for stat() but are absent from `onDisk` (or vice versa). */
  stats?: Map<string, StatStub>;
  hashes?: Record<string, string>;
};

/**
 * In-memory stand-in for MediaRepository plus the queues. Reconcile is a
 * conversation between what the DB holds and what the disk reports, so a fake
 * that stores rows is the only kind that makes these tests mean
 * anything.
 */
function makeDeps (opts: Options = {}) {
  const store = new Map<string, Row>((opts.rows ?? []).map(r => [r.id, r]));
  const onDisk = opts.onDisk ?? [];
  // Default: every walked file also stats successfully with its walked values.
  const stats = opts.stats ?? new Map(onDisk.map(f => [f.absPath, { size: f.size, mtimeMs: f.mtimeMs! }]));

  const created: Prisma.MediaCreateManyInput[] = [];
  const events: Array<{ mediaId: string; field: string; value: string }> = [];

  /** Every path the sweep chose to stream-hash — the cost the size bucketing
   *  exists to avoid, so it is asserted on directly. */
  const hashedPaths: string[] = [];

  const mediaRepository = {
    listReconcileEntries: async (_u: string, root: string) =>
      [...store.values()]
        .filter(r => r.sourcePath.startsWith(root + path.sep))
        .map(r => ({
          id: r.id,
          sourcePath: r.sourcePath,
          mimeType: r.mimeType,
          storageKey: r.storageKey,
          sizeBytes: r.sizeBytes,
          mtimeMs: r.mtimeMs,
          fileDate: r.fileDate,
          missingSince: r.missingSince,
        })),
    markMissing: async (_u: string, ids: string[], at: Date = new Date()) => {
      let n = 0;
      for (const id of ids) {
        const row = store.get(id);
        if (row && row.missingSince === null) { row.missingSince = at; n++; }
      }
      return n;
    },
    clearMissing: async (_u: string, ids: string[]) => {
      for (const id of ids) {
        const row = store.get(id);
        if (row) row.missingSince = null;
      }
    },
    findMoveCandidates: async (_u: string, since: Date) =>
      [...store.values()]
        .filter(r => r.missingSince !== null && r.missingSince >= since)
        .map(r => ({
          id: r.id,
          basename: path.basename(r.sourcePath),
          sizeBytes: r.sizeBytes,
          mtimeMs: r.mtimeMs,
          contentHash: r.contentHash,
          titleIsUserEdited: r.titleIsUserEdited,
        })),
    applyMove: async (
      _u: string,
      id: string,
      data: { sourcePath: string; filename: string; sizeBytes: number; mtimeMs: number | null; title?: string },
    ) => {
      const row = store.get(id);
      if (!row) return;
      row.sourcePath = data.sourcePath;
      row.filename = data.filename;
      row.sizeBytes = data.sizeBytes;
      if (data.mtimeMs !== null) row.mtimeMs = data.mtimeMs;
      if (data.title !== undefined) row.title = data.title;
      row.missingSince = null;
    },
    applySourceChanged: async (
      _u: string,
      id: string,
      data: { sizeBytes: number; mtimeMs: number | null; resetThumb: boolean; resetText: boolean; resetHash: boolean; fileDate?: Date },
    ) => {
      const row = store.get(id);
      if (!row) return;
      row.sizeBytes = data.sizeBytes;
      if (data.mtimeMs !== null) row.mtimeMs = data.mtimeMs;
      if (data.fileDate !== undefined) row.fileDate = data.fileDate;
      row.missingSince = null;
      row.contentHash = null;
      // Mirrors the repository: the state goes back to PENDING *and* the
      // dispatch stamp is cleared, which together are what put the row back in
      // the feeder's claim set.
      if (data.resetThumb) { row.thumbState = "PENDING"; row.thumbQueuedAt = null; }
      if (data.resetText) { row.textState = "PENDING"; row.textQueuedAt = null; }
      if (data.resetHash) { row.hashState = "PENDING"; row.hashQueuedAt = null; }
    },
    healSourceMetadata: async (
      _u: string,
      id: string,
      data: { mtimeMs?: number; fileDate?: Date },
    ) => {
      const row = store.get(id);
      if (!row) return;
      if (data.mtimeMs !== undefined) row.mtimeMs = data.mtimeMs;
      // Mirrors the repository's `fileDate: null` guard in the WHERE clause.
      if (data.fileDate !== undefined && row.fileDate === null) row.fileDate = data.fileDate;
    },
    // Used by indexFiles for the genuinely-new path.
    findExistingSourcePaths: async (_u: string, paths: string[]) => {
      const live = new Set([...store.values()].map(r => r.sourcePath));
      return new Set(paths.filter(p2 => live.has(p2)));
    },
    createBatch: async (rows: Prisma.MediaCreateManyInput[]) => {
      created.push(...rows);
      for (const r of rows) {
        store.set(r.id as string, makeRow({
          id: r.id as string,
          sourcePath: r.sourcePath as string,
          sizeBytes: r.sizeBytes as number,
          mtimeMs: (r.sourceMtimeMs as number | null) ?? null,
        }));
      }
    },
    backfillFileDates: async () => {},
    markTextUnsupported: async () => {},
    markThumbUnsupported: async () => {},
    markThumbTooLarge: async () => {},
  };

  const deps = {
    mediaRepository: mediaRepository as never,
    listTagRules: async () => [],
    publishJobUpdate: (u: { mediaId: string; field: string; value: string }) => { events.push(u); },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    statFile: async (absPath: string) => {
      const st = stats.get(absPath);
      if (!st) throw new Error("ENOENT");
      return st;
    },
    hashFile: async (absPath: string) => {
      hashedPaths.push(absPath);
      return opts.hashes?.[absPath] ?? null;
    },
    walkRoot: async function* () {
      for (const f of onDisk) yield f;
    },
  };

  return { deps, store, created, events, hashedPaths };
}

/** Minimal BullMQ Job stand-in — reconcile only uses `data` + `updateProgress`. */
function makeJob (over: Partial<ReconcileJobData> = {}): Job<ReconcileJobData> {
  return {
    data: {
      userId: "u1",
      rootPath: ROOT,
      allowedRoots: [ROOT],
      ignoreHidden: true,
      ...over,
    },
    updateProgress: async () => {},
  } as unknown as Job<ReconcileJobData>;
}

const run = async (opts: Options, jobOver?: Partial<ReconcileJobData>) => {
  const ctx = makeDeps(opts);
  const processor = createReconcileProcessor(ctx.deps);
  const progress = (await processor(makeJob(jobOver), "token")) as ReconcileJobProgress;
  return { ...ctx, progress };
};

test("tombstones a row whose file vanished while Vault was down", async () => {
  const { store, progress, events } = await run({
    rows: [makeRow({ id: "m1", sourcePath: p("gone.jpg") })],
    onDisk: [],
  });

  assert.equal(progress.missing, 1);
  assert.equal(progress.checked, 1);
  // Tombstoned, never deleted — the row still holds everything the user added.
  assert.ok(store.get("m1"));
  assert.notEqual(store.get("m1")!.missingSince, null);
  assert.ok(events.some(e => e.field === "mediaMissing" && e.value === "1"));
});

test("does not re-stamp a row that was already tombstoned", async () => {
  const stamped = new Date("2026-07-01T00:00:00Z");
  const { store, progress } = await run({
    rows: [makeRow({ id: "m1", sourcePath: p("gone.jpg"), missingSince: stamped })],
    onDisk: [],
  });

  // Re-stamping would restart the grace period on every sweep, so a file that
  // has been gone for weeks would never be swept.
  assert.equal(progress.missing, 0);
  assert.equal(store.get("m1")!.missingSince!.getTime(), stamped.getTime());
});

test("revives a tombstoned row whose file came back at the same path", async () => {
  const file = makeFile(p("back.jpg"));
  const { store, progress } = await run({
    rows: [makeRow({ id: "m1", sourcePath: p("back.jpg"), missingSince: new Date("2026-07-01") })],
    onDisk: [file],
  });

  assert.equal(progress.revived, 1);
  assert.equal(progress.missing, 0);
  assert.equal(store.get("m1")!.missingSince, null);
});

test("matches a file that moved while Vault was down to its existing row", async () => {
  const { store, created, progress } = await run({
    rows: [makeRow({ id: "m1", sourcePath: p("old", "photo.jpg"), sizeBytes: 100, mtimeMs: 1000 })],
    // Same bytes, new directory: the row is gone from its old path and a file
    // with identical size + mtime + name shows up elsewhere.
    onDisk: [makeFile(p("new", "photo.jpg"), 100, 1000)],
  });

  assert.equal(progress.moved, 1);
  assert.equal(progress.added, 0);
  assert.equal(created.length, 0, "a move must not create a second row");
  // Same id, new path — bookmarked /media/[id] links keep working.
  assert.equal(store.get("m1")!.sourcePath, p("new", "photo.jpg"));
  assert.equal(store.get("m1")!.missingSince, null);
});

test("keeps a user-edited title through a rename, but re-derives an auto one", async () => {
  const edited = await run({
    rows: [makeRow({
      id: "m1", sourcePath: p("a.jpg"), title: "Wedding day", titleIsUserEdited: true,
    })],
    onDisk: [makeFile(p("b.jpg"))],
  });
  assert.equal(edited.store.get("m1")!.title, "Wedding day");

  const auto = await run({
    rows: [makeRow({ id: "m1", sourcePath: p("a.jpg"), title: "a", titleIsUserEdited: false })],
    onDisk: [makeFile(p("b.jpg"))],
  });
  assert.equal(auto.store.get("m1")!.title, "b");
});

test("breaks an ambiguous move with a content hash", async () => {
  const dest = p("new", "photo.jpg");
  const { store, progress } = await run({
    rows: [
      // Two tombstones indistinguishable by size + mtime, so metadata alone
      // cannot say which row the new file is.
      makeRow({ id: "m1", sourcePath: p("old", "photo.jpg"), sizeBytes: 100, mtimeMs: 1000, contentHash: "aaa" }),
      makeRow({ id: "m2", sourcePath: p("old2", "photo.jpg"), sizeBytes: 100, mtimeMs: 1000, contentHash: "bbb" }),
    ],
    onDisk: [makeFile(dest, 100, 1000)],
    hashes: { [dest]: "bbb" },
  });

  assert.equal(progress.moved, 1);
  assert.equal(store.get("m2")!.sourcePath, dest);
  // The one that did not match stays tombstoned rather than being guessed at.
  assert.notEqual(store.get("m1")!.missingSince, null);
});

test("re-queues derived work when a file's bytes changed under us", async () => {
  const ctx = await run({
    rows: [makeRow({ id: "m1", sourcePath: p("edited.jpg"), sizeBytes: 100, mtimeMs: 1000, contentHash: "old" })],
    onDisk: [makeFile(p("edited.jpg"), 250, 2000)],
  });

  assert.equal(ctx.progress.changed, 1);
  const row = ctx.store.get("m1")!;
  assert.equal(row.sizeBytes, 250);
  assert.equal(row.mtimeMs, 2000);
  // A stale hash would make dedup claim two different files are the same.
  assert.equal(row.contentHash, null);
  // Back to PENDING with the dispatch stamp cleared: reconcile enqueues nothing
  // itself, so this is the whole handoff to the feeder. Leaving the stamp set
  // would strand the row — never re-fed, then marked FAILED by stall detection.
  assert.equal(row.thumbState, "PENDING");
  assert.equal(row.thumbQueuedAt, null);
  assert.equal(row.textState, "PENDING");
  assert.equal(row.textQueuedAt, null);
  // Renderable (image/jpeg, the row's default mimeType): the re-queued thumb
  // job will rehash it inline, so this must stay UNSUPPORTED rather than
  // getting its own redundant hash job.
  assert.equal(row.hashState, "UNSUPPORTED");
  assert.equal(row.hashQueuedAt, null);
});

test("re-queues a hash job (state, not a push) when a changed non-renderable file's bytes changed", async () => {
  const ctx = await run({
    rows: [makeRow({
      id: "m1", sourcePath: p("edited.bin"), sizeBytes: 100, mtimeMs: 1000,
      mimeType: "application/octet-stream", contentHash: "old",
    })],
    onDisk: [makeFile(p("edited.bin"), 250, 2000)],
  });

  const row = ctx.store.get("m1")!;
  assert.equal(ctx.progress.changed, 1);
  // Not renderable: the thumb worker never touches this row, so it needs its
  // own hash job — back to PENDING with the stamp cleared, same as thumb/text.
  assert.equal(row.hashState, "PENDING");
  assert.equal(row.hashQueuedAt, null);
});

test("leaves an unchanged file completely alone", async () => {
  const ctx = await run({
    rows: [makeRow({ id: "m1", sourcePath: p("same.jpg"), sizeBytes: 100, mtimeMs: 1000 })],
    onDisk: [makeFile(p("same.jpg"), 100, 1000)],
  });

  assert.deepEqual(
    { changed: ctx.progress.changed, missing: ctx.progress.missing, moved: ctx.progress.moved, added: ctx.progress.added },
    { changed: 0, missing: 0, moved: 0, added: 0 },
  );
  assert.equal(ctx.store.get("m1")!.thumbState, "READY");
});

test("indexes a file that is genuinely new", async () => {
  const ctx = await run({ rows: [], onDisk: [makeFile(p("fresh.jpg"))] });

  assert.equal(ctx.progress.added, 1);
  assert.equal(ctx.progress.scanned, 1);
  assert.equal(ctx.created.length, 1);
  assert.equal(ctx.created[0]!.sourcePath, p("fresh.jpg"));
});

test("skips a file that already has a row instead of re-indexing it", async () => {
  const ctx = await run({
    rows: [makeRow({ id: "m1", sourcePath: p("known.jpg") })],
    onDisk: [makeFile(p("known.jpg"))],
  });

  assert.equal(ctx.progress.scanned, 1);
  assert.equal(ctx.progress.added, 0);
  assert.equal(ctx.created.length, 0);
});

test("a delete and an unrelated new file are not mistaken for a move", async () => {
  const ctx = await run({
    rows: [makeRow({ id: "m1", sourcePath: p("gone.jpg"), sizeBytes: 100, mtimeMs: 1000 })],
    // Different size and mtime: nothing about this says it is the same file.
    onDisk: [makeFile(p("other.jpg"), 999, 5000)],
  });

  assert.equal(ctx.progress.moved, 0);
  assert.equal(ctx.progress.missing, 1);
  assert.equal(ctx.progress.added, 1);
});

test("a bumped abort epoch stops the sweep before it indexes anything", async () => {
  const ctx = makeDeps({ rows: [], onDisk: [makeFile(p("a.jpg")), makeFile(p("b.jpg"))] });
  // The epoch is captured once at start and compared against later reads, so a
  // constant value never aborts — the bump has to land *after* the sweep began,
  // which is what pressing stop mid-run does.
  let started = false;
  const processor = createReconcileProcessor({
    ...ctx.deps,
    readAbortEpoch: async () => { if (!started) { started = true; return 0; } return 1; },
    batchSize: 1,
  });
  const progress = (await processor(makeJob(), "token")) as ReconcileJobProgress;

  assert.equal(progress.aborted, true);
  assert.equal(progress.added, 0);
  assert.equal(ctx.created.length, 0);
});

test("heals a legacy row's missing mtime and fileDate without touching its hash", async () => {
  const ctx = await run({
    // A row from before sourceMtimeMs / fileDate existed. The file is unchanged.
    rows: [makeRow({
      id: "m1", sourcePath: p("legacy.jpg"), sizeBytes: 100,
      mtimeMs: null, fileDate: null, contentHash: "abc123",
    })],
    onDisk: [makeFile(p("legacy.jpg"), 100, 5000)],
  });

  const row = ctx.store.get("m1")!;
  assert.equal(row.mtimeMs, 5000, "mtime should be healed from the stat in hand");
  assert.equal(row.fileDate?.getTime(), 5000, "fileDate should be backfilled from mtime");
  // The whole point: nothing about the bytes changed, so the hash is still
  // valid — and nothing was queued that would recompute it if we dropped it.
  assert.equal(row.contentHash, "abc123", "contentHash must survive a metadata heal");

  // A heal is not a change — hashState/hashQueuedAt untouched, still their
  // just-indexed defaults.
  assert.equal(row.hashState, "UNSUPPORTED");
  assert.equal(row.hashQueuedAt, null);
  assert.equal(ctx.progress.changed, 0);
});

test("a metadata heal never overwrites an EXIF-derived fileDate", async () => {
  const exifDate = new Date("2019-04-01T00:00:00Z");
  const ctx = await run({
    rows: [makeRow({
      id: "m1", sourcePath: p("photo.jpg"), sizeBytes: 100,
      mtimeMs: null, fileDate: exifDate,
    })],
    onDisk: [makeFile(p("photo.jpg"), 100, 5000)],
  });

  const row = ctx.store.get("m1")!;
  assert.equal(row.mtimeMs, 5000, "the mtime still gets healed");
  // mtime is the lowest-precedence date source; an embedded date beats it.
  assert.equal(row.fileDate?.getTime(), exifDate.getTime());
});

test("an aborted sweep writes no tombstones", async () => {
  const ctx = makeDeps({
    rows: [
      makeRow({ id: "m1", sourcePath: p("gone1.jpg") }),
      makeRow({ id: "m2", sourcePath: p("gone2.jpg") }),
    ],
    onDisk: [],
  });
  let started = false;
  const processor = createReconcileProcessor({
    ...ctx.deps,
    readAbortEpoch: async () => { if (!started) { started = true; return 0; } return 1; },
  });
  const progress = (await processor(makeJob(), "token")) as ReconcileJobProgress;

  assert.equal(progress.aborted, true);
  assert.equal(progress.missing, 0);
  // The disk half — the only thing that recognises a tombstone as a move —
  // never runs on abort, and the grace-period sweeper hard-deletes tombstones.
  // So a cancelled check must not leave any behind.
  for (const id of ["m1", "m2"]) {
    assert.equal(ctx.store.get(id)!.missingSince, null, `${id} must not be tombstoned`);
  }
});

test("does not stream-hash a new file when no tombstone shares its size", async () => {
  const ctx = await run({
    // A hashed tombstone exists, but at a different size. Unbucketed, matchIdentity
    // reports "ambiguous" for any pool containing a hash, and the sweep answers
    // that by reading the whole file — for every new file it finds.
    rows: [makeRow({ id: "m1", sourcePath: p("deleted.jpg"), sizeBytes: 999, contentHash: "aaa" })],
    onDisk: [makeFile(p("new1.jpg"), 100, 1000), makeFile(p("new2.jpg"), 100, 1000)],
  });

  assert.deepEqual(ctx.hashedPaths, [], "no same-size candidate means no reason to hash");
  assert.equal(ctx.progress.added, 2);
  assert.equal(ctx.progress.moved, 0);
});

test("still hashes to break a tie among same-size candidates", async () => {
  const dest = p("moved.jpg");
  const ctx = await run({
    rows: [
      makeRow({ id: "m1", sourcePath: p("a", "x.jpg"), sizeBytes: 100, mtimeMs: 1000, contentHash: "aaa" }),
      makeRow({ id: "m2", sourcePath: p("b", "x.jpg"), sizeBytes: 100, mtimeMs: 1000, contentHash: "bbb" }),
    ],
    onDisk: [makeFile(dest, 100, 1000)],
    hashes: { [dest]: "bbb" },
  });

  assert.deepEqual(ctx.hashedPaths, [dest], "a genuine tie is still worth one hash");
  assert.equal(ctx.progress.moved, 1);
  assert.equal(ctx.store.get("m2")!.sourcePath, dest);
});

test("treats a path replaced by a symlink as vanished", async () => {
  const link = p("swapped.jpg");
  const ctx = await run({
    rows: [makeRow({ id: "m1", sourcePath: link, sizeBytes: 100 })],
    onDisk: [], // the walk never yields a symlink
    stats: new Map([[link, { size: 12, mtimeMs: 9000, isSymbolicLink: () => true }]]),
  });

  // Not "changed": re-queueing work would make the workers read through the
  // link, and openSourceStream only allow-list-checks the stored path.
  assert.equal(ctx.progress.changed, 0);
  assert.equal(ctx.progress.missing, 1);

  assert.notEqual(ctx.store.get("m1")!.missingSince, null);
});

test("tells open views when a missing file returns with changed bytes", async () => {
  const ctx = await run({
    rows: [makeRow({
      id: "m1", sourcePath: p("back.jpg"), sizeBytes: 100, mtimeMs: 1000,
      missingSince: new Date("2026-07-01"),
    })],
    onDisk: [makeFile(p("back.jpg"), 250, 2000)],
  });

  assert.equal(ctx.progress.changed, 1);
  assert.equal(ctx.store.get("m1")!.missingSince, null);
  // It takes the `changed` branch, so neither the moved nor the revived publish
  // covers it — without its own event the item stays flagged missing in the UI.
  assert.ok(ctx.events.some(e => e.field === "mediaMoved" && e.mediaId === "m1"));
});

test("refuses a root outside the allow-list", async () => {
  const ctx = makeDeps({});
  const processor = createReconcileProcessor(ctx.deps);
  await assert.rejects(
    () => processor(makeJob({ rootPath: path.resolve("elsewhere"), allowedRoots: [ROOT] }), "token") as Promise<unknown>,
    /not within the allowed indexing roots/,
  );
});
