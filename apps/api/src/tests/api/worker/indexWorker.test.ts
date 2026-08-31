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
  const backfilled: { sourcePath: string; fileDate: Date }[] = [];

  const mediaRepository = {
    findExistingSourcePaths: async (_userId: string, paths: string[]) =>
      new Set(paths.filter(p => existingPaths.includes(p))),
    backfillFileDates: async (_userId: string, items: { sourcePath: string; fileDate: Date }[]) => {
      backfilled.push(...items);
    },
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

  // No tag rules by default — rule evaluation itself is covered in evaluateRules.test.ts.
  const listTagRules = async () => [];

  return { mediaRepository, listTagRules, created, unsupported, thumbUnsupported, thumbTooLarge, backfilled };
}

function makeJob (data: { userId: string; rootPath: string; recursive: boolean; ignoreHidden: boolean; allowedRoots?: string[]; blacklistExtensions?: string[]; excludeFolders?: string[]; skipNonContent?: boolean }) {
  return { data: { allowedRoots: [], ...data }, updateProgress: async () => {} } as any;
}

test("indexFiles: marks files over 2 GiB too-large so the feeder never claims them", async () => {
  const deps = makeDeps();
  const GIB = 1024 * 1024 * 1024;
  const files = [
    { absPath: "/r/small.jpg", name: "small.jpg", size: 100 },
    { absPath: "/r/huge.mp4", name: "huge.mp4", size: 3 * GIB }, // > 2 GiB
  ];

  await indexFiles(
    { mediaRepository: deps.mediaRepository, listTagRules: deps.listTagRules },
    "u1",
    files,
    ["/r"],
  );

  const huge = deps.created.find(r => r.filename === "huge.mp4") as { id: string; thumbState: string; hashState: string };
  const small = deps.created.find(r => r.filename === "small.jpg") as { id: string; thumbState: string; hashState: string };

  // The oversize file is moved off PENDING, which is what takes it out of the
  // feeder's claim set — a row the thumbnailer can never buffer must not be fed
  // to it once a tick forever.
  assert.deepEqual(deps.thumbTooLarge, [huge.id]);
  // The small one is simply left at PENDING for the feeder to claim later.
  assert.equal(small.thumbState, "PENDING");
  // Too-large means the thumb worker will never run to hash it as a side
  // effect, so it needs its own hash job; the small renderable one doesn't.
  assert.equal(huge.hashState, "PENDING");
  assert.equal(small.hashState, "UNSUPPORTED");
});

test("indexFiles: autoTagOnIngest off skips rule evaluation entirely", async () => {
  const files = [{ absPath: "/r/a.pdf", name: "a.pdf", size: 100 }];
  const run = async (getAutoTagOnIngest?: () => Promise<boolean>) => {
    const deps = makeDeps();
    let rulesFetched = 0;
    await indexFiles(
      {
        mediaRepository: deps.mediaRepository,
        listTagRules: async () => { rulesFetched += 1; return []; },
        ...(getAutoTagOnIngest ? { getAutoTagOnIngest } : {}),
      },
      "u1",
      files,
      ["/r"],
    );
    return { tags: (deps.created[0] as { tags: string[] }).tags, rulesFetched };
  };

  // With zero rules configured evaluateRules still emits the source: axis, so
  // "no tags at all" is what proves the gate ran ahead of the call rather than
  // the rule set merely being empty.
  assert.deepEqual((await run()).tags, ["source:index"], "absent dep means enabled");
  const off = await run(async () => false);
  assert.deepEqual(off.tags, []);
  assert.equal(off.rulesFetched, 0, "no rules fetch when the preference is off");
});

test("indexFiles: enqueues no thumb, text, or hash work — the row at PENDING is the backlog", async () => {
  const deps = makeDeps();
  const files = [{ absPath: "/r/a.pdf", name: "a.pdf", size: 100 }];

  await indexFiles(
    { mediaRepository: deps.mediaRepository, listTagRules: deps.listTagRules },
    "u1",
    files,
    ["/r"],
  );

  // Pushing here is what filled Redis with tens of thousands of undrainable jobs
  // on a large library. The contract with the feeder is the row itself: PENDING
  // state, no dispatch stamp.
  const [row] = deps.created as unknown as { thumbState: string; textState: string; hashState: string; thumbQueuedAt?: unknown; textQueuedAt?: unknown; hashQueuedAt?: unknown }[];
  assert.equal(row.thumbState, "PENDING");
  assert.equal(row.textState, "PENDING");
  assert.equal(row.thumbQueuedAt, undefined, "a fresh row must look un-dispatched to the feeder");
  assert.equal(row.textQueuedAt, undefined);
  // Renderable and not too large: the thumb worker hashes it inline, so this
  // row must never enter the hash feeder's claim (see hashState in schema.prisma).
  assert.equal(row.hashState, "UNSUPPORTED");
  assert.equal(row.hashQueuedAt, undefined);
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
  // storageKey stays null — in-place rows read from sourcePath, never from
  // managed storage (media_source_xor).
  for (const row of deps.created) {
    assert.ok(row.sourcePath, "row should carry a sourcePath");
    assert.equal(row.sourceState, "READY");
    assert.equal(row.storageKey, null);
  }

  // All 4 files are text-extractable (pdf/jpg/png OCR + txt direct read) → none unsupported.
  assert.equal(deps.unsupported.length, 0);
  // text/plain is still not thumbnailable → exactly one thumb-unsupported id (c.txt).
  assert.equal(deps.thumbUnsupported.length, 1);

  // All 4 rows are left at PENDING for the feeder — 3 of them will get a
  // thumbnail, all 4 will get text extraction, but that is the feeder's call to
  // make on its own schedule, not something the walk commits to Redis up front.
  for (const row of deps.created) assert.equal(row.thumbState, "PENDING");
  for (const row of deps.created) assert.equal(row.textState, "PENDING");
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

test("skipped already-indexed files get a fileDate backfill from the walk's stat", async () => {
  const existingA = path.join(base, "a.pdf");
  const existingB = path.join(base, "b.jpg");
  const deps = makeDeps([existingA, existingB]);
  const processor = createIndexProcessor({ ...deps, logger: makeLogger() });

  await processor(makeJob({ userId: "u1", rootPath: base, recursive: true, ignoreHidden: true, allowedRoots: [base] }));

  // Both skipped rows are offered for backfill with a real mtime-derived date.
  const byPath = new Map(deps.backfilled.map(b => [b.sourcePath, b.fileDate]));
  assert.deepEqual([...byPath.keys()].sort(), [existingA, existingB].sort());
  for (const d of byPath.values()) assert.ok(d instanceof Date && d.getTime() > 0);
  // Newly indexed rows are not part of the backfill.
  assert.ok(!deps.backfilled.some(b => /c\.txt|d\.png/.test(b.sourcePath)));
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
