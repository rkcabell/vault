import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import type { Prisma } from "@prisma/client";
import { createIndexEventHandlers } from "@/worker/indexWatcher.js";
import type { IndexConfig } from "@/services/preferencesService.js";

const ROOT = path.resolve("watch-root");

const NOW = Date.parse("2026-07-26T12:00:00Z");

function makeConfig (overrides: Partial<IndexConfig> = {}): IndexConfig {
  return {
    userId: "u1",
    allowedRoots: [ROOT],
    excludeFolders: [path.join(ROOT, "skip")],
    blacklistExtensions: ["tmp"],
    ignoreHidden: true,
    skipNonContent: true,
    moveDetectionWindowSeconds: 120,
    missingFileGraceDays: 7,
    ...overrides,
  };
}

/** A stored Media row, trimmed to the columns the watcher reads or writes. */
type Row = {
  id: string;
  sourcePath: string;
  filename: string;
  title: string;
  sizeBytes: number;
  mtimeMs: number | null;
  contentHash: string | null;
  titleIsUserEdited: boolean;
  missingSince: Date | null;
  createdAt: Date;
};

function makeRow (over: Partial<Row> & Pick<Row, "id" | "sourcePath">): Row {
  return {
    filename: path.basename(over.sourcePath),
    title: path.basename(over.sourcePath).replace(/\.[^.]+$/, ""),
    sizeBytes: 10,
    mtimeMs: null,
    contentHash: null,
    titleIsUserEdited: false,
    missingSince: null,
    createdAt: new Date(NOW),
    ...over,
  };
}

/**
 * In-memory stand-in for MediaRepository. Move detection is a conversation
 * between the add and unlink handlers through stored state, so a fake that
 * actually holds rows is the only way these tests mean anything.
 */
function makeDeps (opts: { rows?: Row[]; idsByPrefix?: string[] } = {}) {
  const store = new Map<string, Row>(opts.rows?.map(r => [r.id, r]) ?? []);
  const created: Prisma.MediaCreateManyInput[] = [];
  const deleted: Array<{ userId: string; id: string }> = [];
  const regenerated: Array<{ userId: string; id: string }> = [];
  const events: Array<{ mediaId: string; field: string; value: string }> = [];
  const thumbCalls: unknown[][] = [];
  const ocrCalls: unknown[][] = [];

  const byPath = (p: string) => [...store.values()].find(r => r.sourcePath === p) ?? null;
  const toCandidate = (r: Row) => ({
    id: r.id,
    basename: path.basename(r.sourcePath),
    sizeBytes: r.sizeBytes,
    mtimeMs: r.mtimeMs,
    contentHash: r.contentHash,
    titleIsUserEdited: r.titleIsUserEdited,
  });

  const mediaRepository = {
    findExistingSourcePaths: async (_u: string, paths: string[]) =>
      new Set(paths.filter(p => byPath(p) !== null)),
    createBatch: async (rows: Prisma.MediaCreateManyInput[]) => {
      created.push(...rows);
      for (const r of rows) {
        store.set(r.id as string, makeRow({
          id: r.id as string,
          sourcePath: r.sourcePath as string,
          filename: r.filename as string,
          title: r.title as string,
          sizeBytes: r.sizeBytes as number,
          mtimeMs: (r.sourceMtimeMs as number | null) ?? null,
        }));
      }
    },
    backfillFileDates: async () => {},
    markTextUnsupported: async () => {},
    markThumbUnsupported: async () => {},
    markThumbTooLarge: async () => {},
    findIdBySourcePath: async (_u: string, p: string) => byPath(p)?.id ?? null,
    findIdentityBySourcePath: async (_u: string, p: string) => {
      const r = byPath(p);
      return r ? { ...toCandidate(r), sourcePath: r.sourcePath, missingSince: r.missingSince } : null;
    },
    findIdsBySourcePathPrefix: async () => opts.idsByPrefix ?? [],
    findMoveCandidates: async (_u: string, since: Date) =>
      [...store.values()]
        .filter(r => r.missingSince !== null && r.missingSince >= since)
        .map(toCandidate),
    findRecentlyIndexed: async (_u: string, since: Date) =>
      [...store.values()]
        .filter(r => r.missingSince === null && r.createdAt >= since)
        .map(r => ({ ...toCandidate(r), sourcePath: r.sourcePath, filename: r.filename })),
    markMissing: async (_u: string, ids: string[], at: Date = new Date(NOW)) => {
      let n = 0;
      for (const id of ids) {
        const r = store.get(id);
        if (r && r.missingSince === null) { r.missingSince = at; n += 1; }
      }
      return n;
    },
    clearMissing: async (_u: string, ids: string[]) => {
      for (const id of ids) { const r = store.get(id); if (r) r.missingSince = null; }
    },
    applyMove: async (_u: string, id: string, data: any) => {
      const r = store.get(id);
      if (!r) return;
      r.sourcePath = data.sourcePath;
      r.filename = data.filename;
      r.sizeBytes = data.sizeBytes;
      if (data.mtimeMs !== null) r.mtimeMs = data.mtimeMs;
      if (data.title !== undefined) r.title = data.title;
      r.missingSince = null;
    },
  } as any;

  const thumbQueue = { addBulk: async (jobs: unknown[]) => { thumbCalls.push(jobs); return []; } } as any;
  const ocrQueue = { addBulk: async (jobs: unknown[]) => { ocrCalls.push(jobs); return []; } } as any;

  const deps = {
    mediaRepository,
    thumbQueue,
    ocrQueue,
    listTagRules: async () => [],
    publishJobUpdate: (e: any) => { events.push({ mediaId: e.mediaId, field: e.field, value: e.value }); },
    deleteMedia: async (userId: string, id: string) => { deleted.push({ userId, id }); store.delete(id); },
    regenerateThumbnail: async (userId: string, id: string) => { regenerated.push({ userId, id }); },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    statFile: async () => ({ size: 10 }),
    hashFile: async () => null,
    now: () => NOW,
  } as any;

  return { deps, store, created, deleted, regenerated, events, thumbCalls, ocrCalls };
}

test("add: indexes a new file under an allowed root", async () => {
  const t = makeDeps();
  const h = createIndexEventHandlers(t.deps, () => [makeConfig()]);

  await h.onAdd(path.join(ROOT, "a.pdf"));

  assert.equal(t.created.length, 1);
  assert.equal(t.created[0].sourcePath, path.join(ROOT, "a.pdf"));
  assert.equal(t.created[0].sourceState, "READY");
  assert.equal(t.thumbCalls.flat().length, 1);
});

test("add: skips files inside an excluded folder", async () => {
  const t = makeDeps();
  const h = createIndexEventHandlers(t.deps, () => [makeConfig()]);

  await h.onAdd(path.join(ROOT, "skip", "a.pdf"));

  assert.equal(t.created.length, 0);
});

test("add: skips blacklisted extensions and hidden files", async () => {
  const t = makeDeps();
  const h = createIndexEventHandlers(t.deps, () => [makeConfig()]);

  await h.onAdd(path.join(ROOT, "junk.tmp"));
  await h.onAdd(path.join(ROOT, ".secret.pdf"));

  assert.equal(t.created.length, 0);
});

test("add: skips a directory event (chokidar emits add for dirs too)", async () => {
  const t = makeDeps();
  t.deps.statFile = async () => ({ size: 0, isDirectory: () => true });
  const h = createIndexEventHandlers(t.deps, () => [makeConfig()]);

  await h.onAdd(path.join(ROOT, "AlbumFolder"));

  assert.equal(t.created.length, 0);
});

test("add: skips a zero-byte file", async () => {
  const t = makeDeps();
  t.deps.statFile = async () => ({ size: 0 });
  const h = createIndexEventHandlers(t.deps, () => [makeConfig()]);

  await h.onAdd(path.join(ROOT, "empty.pdf"));

  assert.equal(t.created.length, 0);
});

test("add: skips OS metadata and temp files", async () => {
  const t = makeDeps();
  const h = createIndexEventHandlers(t.deps, () => [makeConfig()]);

  await h.onAdd(path.join(ROOT, "Thumbs.db"));
  await h.onAdd(path.join(ROOT, "~$report.docx"));

  assert.equal(t.created.length, 0);
});

test("add: skips source code and build-dir files when skipNonContent is on", async () => {
  const t = makeDeps();
  const h = createIndexEventHandlers(t.deps, () => [makeConfig()]);

  await h.onAdd(path.join(ROOT, "app.ts"));
  await h.onAdd(path.join(ROOT, "node_modules", "x.js"));

  assert.equal(t.created.length, 0);
});

test("add: indexes source code when skipNonContent is off", async () => {
  const t = makeDeps();
  const h = createIndexEventHandlers(t.deps, () => [makeConfig({ skipNonContent: false })]);

  await h.onAdd(path.join(ROOT, "app.ts"));

  assert.equal(t.created.length, 1);
});

test("add: ignores paths outside every allowed root", async () => {
  const t = makeDeps();
  const h = createIndexEventHandlers(t.deps, () => [makeConfig()]);

  await h.onAdd(path.resolve("elsewhere", "a.pdf"));

  assert.equal(t.created.length, 0);
});

test("unlink: tombstones the row instead of deleting it", async () => {
  const target = path.join(ROOT, "gone.pdf");
  const t = makeDeps({ rows: [makeRow({ id: "media-1", sourcePath: target })] });
  const h = createIndexEventHandlers(t.deps, () => [makeConfig()]);

  await h.onUnlink(target);

  // Nothing is destroyed — the row and everything hanging off it survives.
  assert.equal(t.deleted.length, 0);
  assert.notEqual(t.store.get("media-1")!.missingSince, null);
  assert.deepEqual(t.events, [{ mediaId: "media-1", field: "mediaMissing", value: "1" }]);
});

test("unlink: no-op when no row matches", async () => {
  const t = makeDeps();
  const h = createIndexEventHandlers(t.deps, () => [makeConfig()]);

  await h.onUnlink(path.join(ROOT, "never-indexed.pdf"));

  assert.equal(t.deleted.length, 0);
  assert.equal(t.events.length, 0);
});

test("unlinkDir: tombstones every row beneath the removed directory", async () => {
  const t = makeDeps({
    idsByPrefix: ["m1", "m2", "m3"],
    rows: ["m1", "m2", "m3"].map(id =>
      makeRow({ id, sourcePath: path.join(ROOT, "albums", `${id}.pdf`) })),
  });
  const h = createIndexEventHandlers(t.deps, () => [makeConfig()]);

  await h.onUnlinkDir(path.join(ROOT, "albums"));

  assert.equal(t.deleted.length, 0);
  assert.deepEqual([...t.store.values()].map(r => r.missingSince === null), [false, false, false]);
  assert.deepEqual(t.events, [{ mediaId: "*", field: "mediaMissing", value: "3" }]);
});

test("move: an unlink+add pair keeps the original row, id and metadata", async () => {
  const from = path.join(ROOT, "a", "photo.jpg");
  const to = path.join(ROOT, "b", "photo.jpg");
  const t = makeDeps({
    rows: [makeRow({
      id: "media-1", sourcePath: from, sizeBytes: 4096, mtimeMs: 1_700_000_000_000,
      title: "Tax return 2019", titleIsUserEdited: true,
    })],
  });
  t.deps.statFile = async () => ({ size: 4096, mtimeMs: 1_700_000_000_000 });
  const h = createIndexEventHandlers(t.deps, () => [makeConfig()]);

  await h.onUnlink(from);
  await h.onAdd(to);

  // No new row, no re-thumbnail, no re-OCR — the bytes never changed.
  assert.equal(t.created.length, 0);
  assert.equal(t.thumbCalls.flat().length, 0);
  assert.equal(t.ocrCalls.flat().length, 0);
  const row = t.store.get("media-1")!;
  assert.equal(row.sourcePath, to);
  assert.equal(row.missingSince, null);
  assert.equal(row.title, "Tax return 2019"); // user's title survives the move
  assert.deepEqual(t.events.at(-1), { mediaId: "media-1", field: "mediaMoved", value: "1" });
});

test("rename: same bytes under a new name re-derives only an auto title", async () => {
  const from = path.join(ROOT, "IMG_0421.jpg");
  const to = path.join(ROOT, "beach.jpg");
  const t = makeDeps({
    rows: [makeRow({
      id: "media-1", sourcePath: from, sizeBytes: 4096, mtimeMs: 1_700_000_000_000,
      title: "IMG_0421", titleIsUserEdited: false,
    })],
  });
  t.deps.statFile = async () => ({ size: 4096, mtimeMs: 1_700_000_000_000 });
  const h = createIndexEventHandlers(t.deps, () => [makeConfig()]);

  await h.onUnlink(from);
  await h.onAdd(to);

  assert.equal(t.created.length, 0);
  const row = t.store.get("media-1")!;
  assert.equal(row.sourcePath, to);
  assert.equal(row.filename, "beach.jpg");
  assert.equal(row.title, "beach"); // auto-derived title follows the filename
});

test("move: reversed event order still reclaims the original row", async () => {
  const from = path.join(ROOT, "a", "photo.jpg");
  const to = path.join(ROOT, "b", "photo.jpg");
  const t = makeDeps({
    rows: [makeRow({
      id: "media-1", sourcePath: from, sizeBytes: 4096, mtimeMs: 1_700_000_000_000,
      title: "Passport scan", titleIsUserEdited: true,
    })],
  });
  t.deps.statFile = async () => ({ size: 4096, mtimeMs: 1_700_000_000_000 });
  const h = createIndexEventHandlers(t.deps, () => [makeConfig()]);

  // Some platforms report the destination before the source disappears.
  await h.onAdd(to);
  await h.onUnlink(from);

  // The bare row created by the early `add` is absorbed; the original survives.
  assert.equal(t.created.length, 1);
  assert.equal(t.deleted.length, 1);
  const row = t.store.get("media-1")!;
  assert.equal(row.sourcePath, to);
  assert.equal(row.missingSince, null);
  assert.equal(row.title, "Passport scan");
  assert.deepEqual(t.events.at(-1), { mediaId: "media-1", field: "mediaMoved", value: "1" });
});

test("add: an unrelated new file is indexed, not matched to a tombstone", async () => {
  const t = makeDeps({
    rows: [makeRow({
      id: "media-1", sourcePath: path.join(ROOT, "gone.pdf"),
      sizeBytes: 4096, mtimeMs: 1_700_000_000_000, missingSince: new Date(NOW),
    })],
  });
  t.deps.statFile = async () => ({ size: 999, mtimeMs: 1_800_000_000_000 });
  const h = createIndexEventHandlers(t.deps, () => [makeConfig()]);

  await h.onAdd(path.join(ROOT, "brand-new.pdf"));

  assert.equal(t.created.length, 1);
  assert.notEqual(t.store.get("media-1")!.missingSince, null); // still missing
});

test("add: a file older than the move window is not treated as a move", async () => {
  const t = makeDeps({
    rows: [makeRow({
      id: "media-1", sourcePath: path.join(ROOT, "a", "photo.jpg"),
      sizeBytes: 4096, mtimeMs: 1_700_000_000_000,
      missingSince: new Date(NOW - 10 * 60 * 1000), // 10 min ago, window is 2 min
    })],
  });
  t.deps.statFile = async () => ({ size: 4096, mtimeMs: 1_700_000_000_000 });
  const h = createIndexEventHandlers(t.deps, () => [makeConfig()]);

  await h.onAdd(path.join(ROOT, "b", "photo.jpg"));

  assert.equal(t.created.length, 1);
});

test("add: a missing file reappearing at its own path is revived and refreshed", async () => {
  const target = path.join(ROOT, "unmounted.pdf");
  const t = makeDeps({
    rows: [makeRow({
      id: "media-1", sourcePath: target, sizeBytes: 4096,
      mtimeMs: 1_700_000_000_000, missingSince: new Date(NOW),
    })],
  });
  // Different bytes than we last saw: no identity match would fire, so this
  // exercises the same-path revival rather than the move matcher.
  t.deps.statFile = async () => ({ size: 8192, mtimeMs: 1_900_000_000_000 });
  const h = createIndexEventHandlers(t.deps, () => [makeConfig()]);

  await h.onAdd(target);

  assert.equal(t.created.length, 0);
  assert.equal(t.store.get("media-1")!.missingSince, null);
  assert.deepEqual(t.regenerated, [{ userId: "u1", id: "media-1" }]);
});

test("change: regenerates the thumbnail for an indexed file", async () => {
  const target = path.join(ROOT, "edited.pdf");
  const t = makeDeps({ rows: [makeRow({ id: "media-9", sourcePath: target })] });
  const h = createIndexEventHandlers(t.deps, () => [makeConfig()]);

  await h.onChange(target);

  assert.deepEqual(t.regenerated, [{ userId: "u1", id: "media-9" }]);
  assert.equal(t.created.length, 0);
});

test("change: indexes the file when no row exists yet (missed add)", async () => {
  const t = makeDeps(); // findIdBySourcePath returns null
  const h = createIndexEventHandlers(t.deps, () => [makeConfig()]);

  await h.onChange(path.join(ROOT, "appeared.pdf"));

  assert.equal(t.created.length, 1);
  assert.equal(t.regenerated.length, 0);
});
