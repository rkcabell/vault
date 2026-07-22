import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import type { Prisma } from "@prisma/client";
import { createIndexEventHandlers } from "@/worker/indexWatcher.js";
import type { IndexConfig } from "@/services/preferencesService.js";

const ROOT = path.resolve("watch-root");

function makeConfig (overrides: Partial<IndexConfig> = {}): IndexConfig {
  return {
    userId: "u1",
    allowedRoots: [ROOT],
    excludeFolders: [path.join(ROOT, "skip")],
    blacklistExtensions: ["tmp"],
    ignoreHidden: true,
    skipNonContent: true,
    ...overrides,
  };
}

// Records DB writes + queue/service calls so tests can assert on them.
function makeDeps (opts: { idByPath?: Record<string, string>; idsByPrefix?: string[] } = {}) {
  const created: Prisma.MediaCreateManyInput[] = [];
  const deleted: Array<{ userId: string; id: string }> = [];
  const regenerated: Array<{ userId: string; id: string }> = [];
  const thumbCalls: unknown[][] = [];
  const ocrCalls: unknown[][] = [];

  const mediaRepository = {
    findExistingSourcePaths: async () => new Set<string>(),
    createBatch: async (rows: Prisma.MediaCreateManyInput[]) => { created.push(...rows); },
    markTextUnsupported: async () => {},
    markThumbUnsupported: async () => {},
    findIdBySourcePath: async (_userId: string, p: string) => opts.idByPath?.[p] ?? null,
    findIdsBySourcePathPrefix: async () => opts.idsByPrefix ?? [],
  } as any;

  const thumbQueue = { addBulk: async (jobs: unknown[]) => { thumbCalls.push(jobs); return []; } } as any;
  const ocrQueue = { addBulk: async (jobs: unknown[]) => { ocrCalls.push(jobs); return []; } } as any;

  const deps = {
    mediaRepository,
    thumbQueue,
    ocrQueue,
    listTagRules: async () => [],
    deleteMedia: async (userId: string, id: string) => { deleted.push({ userId, id }); },
    regenerateThumbnail: async (userId: string, id: string) => { regenerated.push({ userId, id }); },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    statFile: async () => ({ size: 10 }),
  } as any;

  return { deps, created, deleted, regenerated, thumbCalls, ocrCalls };
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

test("unlink: deletes the row when one exists for that source path", async () => {
  const target = path.join(ROOT, "gone.pdf");
  const t = makeDeps({ idByPath: { [target]: "media-1" } });
  const h = createIndexEventHandlers(t.deps, () => [makeConfig()]);

  await h.onUnlink(target);

  assert.deepEqual(t.deleted, [{ userId: "u1", id: "media-1" }]);
});

test("unlink: no-op when no row matches", async () => {
  const t = makeDeps();
  const h = createIndexEventHandlers(t.deps, () => [makeConfig()]);

  await h.onUnlink(path.join(ROOT, "never-indexed.pdf"));

  assert.equal(t.deleted.length, 0);
});

test("unlinkDir: deletes every row beneath the removed directory", async () => {
  const t = makeDeps({ idsByPrefix: ["m1", "m2", "m3"] });
  const h = createIndexEventHandlers(t.deps, () => [makeConfig()]);

  await h.onUnlinkDir(path.join(ROOT, "albums"));

  assert.deepEqual(t.deleted.map(d => d.id), ["m1", "m2", "m3"]);
});

test("change: regenerates the thumbnail for an indexed file", async () => {
  const target = path.join(ROOT, "edited.pdf");
  const t = makeDeps({ idByPath: { [target]: "media-9" } });
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
