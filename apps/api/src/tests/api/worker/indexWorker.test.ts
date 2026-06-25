import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Prisma } from "@prisma/client";
import { createIndexProcessor } from "@/worker/indexWorker.js";
import { indexFiles } from "@/worker/indexCore.js";
import { PathNotAllowedError } from "@/lib/media/indexRoots.js";

function makeLogger () {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

// Records inserted rows + enqueued bulk calls so tests can assert on them.
function makeDeps (existingPaths: string[] = []) {
  const created: Prisma.MediaCreateManyInput[] = [];
  const unsupported: string[] = [];
  const thumbUnsupported: string[] = [];
  const thumbTooLarge: string[] = [];
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
    markThumbUnsupported: async (ids: string[]) => {
      thumbUnsupported.push(...ids);
    },
    markThumbTooLarge: async (ids: string[]) => {
      thumbTooLarge.push(...ids);
    },

  } as any;


  const thumbQueue = { addBulk: async (jobs: unknown[]) => { thumbCalls.push(jobs); return []; } } as any;

  const ocrQueue = { addBulk: async (jobs: unknown[]) => { ocrCalls.push(jobs); return []; } } as any;

  return { mediaRepository, thumbQueue, ocrQueue, created, unsupported, thumbUnsupported, thumbTooLarge, thumbCalls, ocrCalls };
}

function makeJob (data: { userId: string; rootPath: string; recursive: boolean; ignoreHidden: boolean; allowedRoots?: string[]; blacklistExtensions?: string[]; excludeFolders?: string[]; skipNonContent?: boolean }) {
  return { data: { allowedRoots: [], ...data }, updateProgress: async () => {} } as any;
}

test("indexFiles: skips the thumbnail enqueue for files over 2 GiB, marks them too-large", async () => {
  const deps = makeDeps();
  const GIB = 1024 * 1024 * 1024;
  const files = [
    { absPath: "/r/small.jpg", name: "small.jpg", size: 100 },
    { absPath: "/r/huge.mp4", name: "huge.mp4", size: 3 * GIB }, // > 2 GiB
  ];

  await indexFiles(
    { mediaRepository: deps.mediaRepository, thumbQueue: deps.thumbQueue, ocrQueue: deps.ocrQueue },
    "u1",
    files,
    ["/r"],
  );

  const hugeId = (deps.created.find(r => r.filename === "huge.mp4") as { id: string }).id;
  const smallId = (deps.created.find(r => r.filename === "small.jpg") as { id: string }).id;

  // Oversize file: marked too-large, never enqueued.
  assert.deepEqual(deps.thumbTooLarge, [hugeId]);
  const enqueuedIds = deps.thumbCalls.flat().map((j: any) => j.data.mediaId);
  assert.deepEqual(enqueuedIds, [smallId]);
});

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

  // All 4 files are text-extractable (pdf/jpg/png OCR + txt direct read) → none unsupported.
  assert.equal(deps.unsupported.length, 0);
  // text/plain is still not thumbnailable → exactly one thumb-unsupported id (c.txt).
  assert.equal(deps.thumbUnsupported.length, 1);

  // Thumbnails for the 3 image/pdf files; text extraction enqueued for all 4 (incl. c.txt).
  const thumbJobs = deps.thumbCalls.flat();
  const ocrJobs = deps.ocrCalls.flat();
  assert.equal(thumbJobs.length, 3);
  assert.equal(ocrJobs.length, 4);
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

test("blacklisted extensions are skipped (case/dot-insensitive)", async () => {
  const deps = makeDeps();
  const processor = createIndexProcessor({ ...deps, logger: makeLogger() });

  // ".JPG" and "TXT" should normalize and exclude b.jpg + c.txt.
  const result = await processor(makeJob({
    userId: "u1", rootPath: base, recursive: true, ignoreHidden: true,
    allowedRoots: [base], blacklistExtensions: [".JPG", "TXT"],
  }));

  // Remaining: a.pdf, sub/d.png.
  assert.equal((result as { indexed: number }).indexed, 2);
  assert.ok(!deps.created.some(r => String(r.sourcePath).endsWith(".jpg")));
  assert.ok(!deps.created.some(r => String(r.sourcePath).endsWith(".txt")));
  assert.ok(deps.created.some(r => String(r.sourcePath).endsWith("a.pdf")));
  assert.ok(deps.created.some(r => String(r.sourcePath).endsWith("d.png")));
});

test("empty blacklist indexes everything (backward compatible)", async () => {
  const deps = makeDeps();
  const processor = createIndexProcessor({ ...deps, logger: makeLogger() });
  const result = await processor(makeJob({
    userId: "u1", rootPath: base, recursive: true, ignoreHidden: true,
    allowedRoots: [base], blacklistExtensions: [],
  }));
  assert.equal((result as { indexed: number }).indexed, 4);
});

test("excluded folders (and their contents) are skipped", async () => {
  const deps = makeDeps();
  const processor = createIndexProcessor({ ...deps, logger: makeLogger() });

  const result = await processor(makeJob({
    userId: "u1", rootPath: base, recursive: true, ignoreHidden: true,
    allowedRoots: [base], excludeFolders: [path.join(base, "sub")],
  }));

  // sub/d.png is under an excluded folder → only the 3 top-level files index.
  assert.equal((result as { indexed: number }).indexed, 3);
  assert.ok(!deps.created.some(r => String(r.sourcePath).includes("sub")));
});

test("skipNonContent (default on) skips build dirs and non-content files", async () => {
  await mkdir(path.join(base, "node_modules"));
  await writeFile(path.join(base, "node_modules", "x.js"), "js");
  await writeFile(path.join(base, "app.ts"), "ts");
  await writeFile(path.join(base, "tool.dll"), "bin");

  const deps = makeDeps();
  const processor = createIndexProcessor({ ...deps, logger: makeLogger() });

  // skipNonContent omitted → defaults true. Only the 4 content files index.
  const result = await processor(makeJob({ userId: "u1", rootPath: base, recursive: true, ignoreHidden: true, allowedRoots: [base] }));

  assert.equal((result as { indexed: number }).indexed, 4);
  assert.ok(!deps.created.some(r => String(r.sourcePath).includes("node_modules")));
  assert.ok(!deps.created.some(r => String(r.sourcePath).endsWith(".ts")));
  assert.ok(!deps.created.some(r => String(r.sourcePath).endsWith(".dll")));
});

test("skipNonContent off indexes source code and binaries", async () => {
  await mkdir(path.join(base, "node_modules"));
  await writeFile(path.join(base, "node_modules", "x.js"), "js");
  await writeFile(path.join(base, "tool.dll"), "bin");

  const deps = makeDeps();
  const processor = createIndexProcessor({ ...deps, logger: makeLogger() });

  // 4 content files + node_modules/x.js + tool.dll = 6.
  const result = await processor(makeJob({ userId: "u1", rootPath: base, recursive: true, ignoreHidden: true, allowedRoots: [base], skipNonContent: false }));

  assert.equal((result as { indexed: number }).indexed, 6);
  assert.ok(deps.created.some(r => String(r.sourcePath).includes("node_modules")));
  assert.ok(deps.created.some(r => String(r.sourcePath).endsWith(".dll")));
});

test("temp/cache subtrees are skipped when skipNonContent is on, walked when off", async () => {
  await mkdir(path.join(base, "TEMP", "sub"), { recursive: true });
  await writeFile(path.join(base, "TEMP", "sub", "f83a4820"), "cachejunk"); // hash-named, extension-less
  await mkdir(path.join(base, "cache"));
  await writeFile(path.join(base, "cache", "blob.png"), "png");

  // skipNonContent on (default): TEMP + cache subtrees never walked → still 4 content files.
  const onDeps = makeDeps();
  const onResult = await createIndexProcessor({ ...onDeps, logger: makeLogger() })(
    makeJob({ userId: "u1", rootPath: base, recursive: true, ignoreHidden: true, allowedRoots: [base] }),
  );
  assert.equal((onResult as { indexed: number }).indexed, 4);
  assert.ok(!onDeps.created.some(r => /TEMP|cache/.test(String(r.sourcePath))));

  // skipNonContent off: the temp/cache contents are walked (f83a4820 + blob.png) → 6.
  const offDeps = makeDeps();
  const offResult = await createIndexProcessor({ ...offDeps, logger: makeLogger() })(
    makeJob({ userId: "u1", rootPath: base, recursive: true, ignoreHidden: true, allowedRoots: [base], skipNonContent: false }),
  );
  assert.equal((offResult as { indexed: number }).indexed, 6);
});

test("filtered count reflects files passed over during the walk", async () => {
  await writeFile(path.join(base, "Thumbs.db"), "thumb");    // junk file
  await writeFile(path.join(base, "empty.pdf"), "");         // zero-byte
  await writeFile(path.join(base, "app.ts"), "ts");          // non-content (skipNonContent on)

  const deps = makeDeps();
  const result = await createIndexProcessor({ ...deps, logger: makeLogger() })(
    makeJob({ userId: "u1", rootPath: base, recursive: true, ignoreHidden: true, allowedRoots: [base] }),
  );

  // 4 original content files indexed; the 3 added files were all filtered.
  assert.equal((result as { indexed: number }).indexed, 4);
  assert.equal((result as { filtered: number }).filtered, 3);
});

test("OS junk, temp/backup files, zero-byte files, and system dirs are skipped", async () => {
  await writeFile(path.join(base, "Thumbs.db"), "thumb");      // OS metadata
  await writeFile(path.join(base, "~$report.docx"), "lock");   // Office lock
  await writeFile(path.join(base, "draft.tmp"), "tmp");        // temp file
  await writeFile(path.join(base, "notes.txt~"), "backup");    // editor backup
  await writeFile(path.join(base, "empty.pdf"), "");           // zero-byte
  await mkdir(path.join(base, "$RECYCLE.BIN"));
  await writeFile(path.join(base, "$RECYCLE.BIN", "trashed.pdf"), "junk");

  const deps = makeDeps();
  const processor = createIndexProcessor({ ...deps, logger: makeLogger() });

  // Still only the 4 original content files — every junk entry is filtered.
  const result = await processor(makeJob({ userId: "u1", rootPath: base, recursive: true, ignoreHidden: true, allowedRoots: [base] }));

  assert.equal((result as { indexed: number }).indexed, 4);
  assert.ok(!deps.created.some(r => /Thumbs\.db|~\$report|draft\.tmp|notes\.txt~|empty\.pdf|RECYCLE/.test(String(r.sourcePath))));
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

// ── cooperative abort ──────────────────────────────────────────────────────────

test("abort signalled before the first batch stops the walk (nothing indexed)", async () => {
  const deps = makeDeps();
  // First read (captured as startEpoch) = 0; every later read = 1 → aborted.
  let reads = 0;
  const readAbortEpoch = async () => (reads++ === 0 ? 0 : 1);
  const processor = createIndexProcessor({ ...deps, logger: makeLogger(), readAbortEpoch, batchSize: 1 });

  const result = await processor(makeJob({ userId: "u1", rootPath: base, recursive: true, ignoreHidden: true, allowedRoots: [base] }));

  assert.equal((result as { aborted?: boolean }).aborted, true);
  assert.equal(deps.created.length, 0, "no rows created once aborted");
  assert.equal(deps.thumbCalls.flat().length, 0, "no thumb jobs enqueued");
  assert.equal(deps.ocrCalls.flat().length, 0, "no ocr jobs enqueued");
});

test("abort mid-walk indexes what was already scanned, then stops", async () => {
  const deps = makeDeps();
  // startEpoch=0; allow the first two batch flushes, then abort.
  let reads = 0;
  const readAbortEpoch = async () => {
    const n = reads++;
    return n <= 2 ? 0 : 1; // calls 0,1,2 → 0 (start + two flushes); call 3+ → aborted
  };
  const processor = createIndexProcessor({ ...deps, logger: makeLogger(), readAbortEpoch, batchSize: 1 });

  const result = await processor(makeJob({ userId: "u1", rootPath: base, recursive: true, ignoreHidden: true, allowedRoots: [base] }));

  // base has 4 indexable files; we stop partway.
  assert.equal((result as { aborted?: boolean }).aborted, true);
  assert.ok(deps.created.length >= 1 && deps.created.length < 4, `partial index, got ${deps.created.length}`);
});

test("no abort signalled → indexes everything (batched)", async () => {
  const deps = makeDeps();
  const processor = createIndexProcessor({ ...deps, logger: makeLogger(), readAbortEpoch: async () => 0, batchSize: 1 });

  const result = await processor(makeJob({ userId: "u1", rootPath: base, recursive: true, ignoreHidden: true, allowedRoots: [base] }));

  assert.equal((result as { aborted?: boolean }).aborted, undefined);
  assert.equal((result as { indexed: number }).indexed, 4);
  assert.equal(deps.created.length, 4);
});
