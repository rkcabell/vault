import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Prisma } from "@prisma/client";
import { createIndexProcessor } from "@/worker/indexWorker.js";
import { PathNotAllowedError } from "@/lib/media/indexRoots.js";

function makeLogger () {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

// Records inserted rows + enqueued bulk calls so tests can assert on them.
function makeDeps (existingPaths: string[] = []) {
  const created: Prisma.MediaCreateManyInput[] = [];
  const unsupported: string[] = [];
  const thumbCalls: unknown[][] = [];
  const ocrCalls: unknown[][] = [];

  const mediaRepository = {
    findExistingSourcePaths: async (_userId: string, paths: string[]) =>
      new Set(paths.filter(p => existingPaths.includes(p))),
    createBatch: async (rows: Prisma.MediaCreateManyInput[]) => {
      created.push(...rows);
    },
    markTextUnsupported: async (ids: string[]) => {
      unsupported.push(...ids);
    },

  } as any;


  const thumbQueue = { addBulk: async (jobs: unknown[]) => { thumbCalls.push(jobs); return []; } } as any;

  const ocrQueue = { addBulk: async (jobs: unknown[]) => { ocrCalls.push(jobs); return []; } } as any;

  return { mediaRepository, thumbQueue, ocrQueue, created, unsupported, thumbCalls, ocrCalls };
}

function makeJob (data: { userId: string; rootPath: string; recursive: boolean; ignoreHidden: boolean; allowedRoots?: string[] }) {
  return { data: { allowedRoots: [], ...data }, updateProgress: async () => {} } as any;
}

let base: string;
beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), "vault-idx-"));
  await writeFile(path.join(base, "a.pdf"), "pdf");
  await writeFile(path.join(base, "b.jpg"), "jpg");
  await writeFile(path.join(base, "c.txt"), "txt"); // not OCR-supported
  await writeFile(path.join(base, ".hidden.png"), "hidden");
  await mkdir(path.join(base, "sub"));
  await writeFile(path.join(base, "sub", "d.png"), "png");
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

test("recursive scan indexes all non-hidden files and marks unsupported text", async () => {
  const deps = makeDeps();
  const processor = createIndexProcessor({ ...deps, logger: makeLogger() });

  const result = await processor(makeJob({ userId: "u1", rootPath: base, recursive: true, ignoreHidden: true, allowedRoots: [base] }));

  // a.pdf, b.jpg, c.txt, sub/d.png — .hidden.png skipped.
  assert.equal(deps.created.length, 4);
  assert.equal((result as { indexed: number }).indexed, 4);

  // Every row references its source in place and is marked source-ready.
  for (const row of deps.created) {
    assert.ok(row.sourcePath, "row should carry a sourcePath");
    assert.equal(row.sourceState, "READY");
    assert.ok(String(row.storageKey).startsWith("external/u1/"));
  }

  // c.txt is the only non-OCR file → exactly one text-unsupported id.
  assert.equal(deps.unsupported.length, 1);

  // Thumbnails for all 4; OCR for the 3 image/pdf files.
  const thumbJobs = deps.thumbCalls.flat();
  const ocrJobs = deps.ocrCalls.flat();
  assert.equal(thumbJobs.length, 4);
  assert.equal(ocrJobs.length, 3);
});

test("non-recursive scan ignores subfolders", async () => {
  const deps = makeDeps();
  const processor = createIndexProcessor({ ...deps, logger: makeLogger() });

  const result = await processor(makeJob({ userId: "u1", rootPath: base, recursive: false, ignoreHidden: true, allowedRoots: [base] }));

  // Only top-level a.pdf, b.jpg, c.txt.
  assert.equal((result as { indexed: number }).indexed, 3);
  assert.ok(!deps.created.some(r => String(r.sourcePath).includes("sub")));
});

test("hidden files are included when ignoreHidden is false", async () => {
  const deps = makeDeps();
  const processor = createIndexProcessor({ ...deps, logger: makeLogger() });

  const result = await processor(makeJob({ userId: "u1", rootPath: base, recursive: true, ignoreHidden: false, allowedRoots: [base] }));

  // 4 visible + .hidden.png = 5.
  assert.equal((result as { indexed: number }).indexed, 5);
});

test("already-indexed paths are skipped, not re-created", async () => {
  const deps = makeDeps([path.join(base, "a.pdf"), path.join(base, "b.jpg")]);
  const processor = createIndexProcessor({ ...deps, logger: makeLogger() });

  const result = await processor(makeJob({ userId: "u1", rootPath: base, recursive: true, ignoreHidden: true, allowedRoots: [base] }));

  // a.pdf + b.jpg pre-existing → only c.txt and sub/d.png are new.
  assert.equal((result as { indexed: number; skipped: number }).indexed, 2);
  assert.equal((result as { skipped: number }).skipped, 2);
  assert.equal(deps.created.length, 2);
});

test("refuses to scan a path outside the allow-list", async () => {
  const deps = makeDeps();
  const processor = createIndexProcessor({ ...deps, logger: makeLogger() });

  await assert.rejects(
    processor(makeJob({ userId: "u1", rootPath: base, recursive: true, ignoreHidden: true, allowedRoots: [path.join(base, "sub")] })),
    (err: unknown) => err instanceof PathNotAllowedError,
  );
  assert.equal(deps.created.length, 0);
});
