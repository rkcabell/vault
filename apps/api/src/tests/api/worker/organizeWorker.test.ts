import test from "node:test";
import assert from "node:assert/strict";
import type { Job } from "bullmq";
import { createOrganizeProcessor, type OrganizeMediaRow } from "@/worker/organizeWorker.js";
import type { OrganizeJobData, OrganizeJobProgress } from "@/queues/enqueueOrganize.js";
import { DEFAULT_TAG_RULES } from "@/lib/tags/rules/defaults.js";
import type { TagRuleInput } from "@/lib/tags/rules/evaluateRules.js";

const defaultRules: TagRuleInput[] = DEFAULT_TAG_RULES.map(r => ({ ...r, enabled: true }));

function makeLogger () {
  return { info: () => {}, warn: () => {} };
}

function makeRow (partial: Partial<OrganizeMediaRow> & Pick<OrganizeMediaRow, "id">): OrganizeMediaRow {
  return {
    title: partial.id,
    filename: `${partial.id}.pdf`,
    mimeType: "application/pdf",
    sizeBytes: 100,
    sourcePath: null,
    isExtractedFromArchive: false,
    tags: [],
    fileDate: null,
    metadata: null,
    ...partial,
  };
}

/** In-memory deps: rows are "the database"; writes are recorded. */
function makeDeps (rows: OrganizeMediaRow[], opts: {
  rules?: TagRuleInput[];
  indexRoots?: string[];
  chunkSize?: number;
  mtimeMs?: number;
  failAddFor?: string[];
} = {}) {
  const added: Array<{ mediaId: string; tags: string[] }> = [];
  const ensured: string[][] = [];
  const reconciled: string[] = [];
  const published: Array<{ field: string; value: string }> = [];
  const fileDates: Array<{ mediaId: string; fileDate: Date }> = [];

  const deps = {
    mediaRepository: {
      countMediaForOrganize: async () => rows.length,
      listMediaForOrganize: async (_userId: string, afterId: string | null, limit: number) => {
        const sorted = [...rows].sort((a, b) => a.id.localeCompare(b.id));
        const start = afterId ? sorted.findIndex(r => r.id > afterId) : 0;
        return start < 0 ? [] : sorted.slice(start, start + limit);
      },
      addTagsToMedia: async (_userId: string, mediaId: string, tags: string[]) => {
        if (opts.failAddFor?.includes(mediaId)) throw new Error("boom");
        added.push({ mediaId, tags });
      },
      ensureAutoTagRows: async (_userId: string, names: string[]) => { ensured.push(names); },
      reconcileTagCounts: async (userId: string) => { reconciled.push(userId); },
      setFileDate: async (mediaId: string, fileDate: Date) => { fileDates.push({ mediaId, fileDate }); },
    },
    tagRuleRepository: { listEnabled: async () => opts.rules ?? defaultRules },
    getIndexRoots: async () => opts.indexRoots ?? [],
    logger: makeLogger(),
    publishJobUpdate: (u: { field: string; value: string }) => { published.push(u); },
    statFile: async () => ({ mtimeMs: opts.mtimeMs ?? 0 }),
    chunkSize: opts.chunkSize ?? 2,
  };

  return { deps, added, ensured, reconciled, published, fileDates };
}

function makeJob (data: OrganizeJobData) {
  const progressUpdates: OrganizeJobProgress[] = [];
  const job = {
    data,
    updateProgress: async (p: unknown) => { progressUpdates.push(structuredClone(p) as OrganizeJobProgress); },
  } as unknown as Job<OrganizeJobData>;
  return { job, progressUpdates };
}

test("organize: adds missing rule tags, ensures rows, reconciles counts, publishes", async () => {
  const rows = [
    makeRow({ id: "m1", filename: "a.pdf", tags: ["type:pdf"] }), // missing source:upload only
    makeRow({ id: "m2", filename: "b.jpg", mimeType: "image/jpeg" }), // missing both
  ];
  const t = makeDeps(rows);
  const { job } = makeJob({ userId: "u1", dryRun: false });

  const result = (await createOrganizeProcessor(t.deps)(job, "tok")) as OrganizeJobProgress;

  assert.equal(result.total, 2);
  assert.equal(result.processed, 2);
  assert.equal(result.updated, 2);
  assert.equal(result.tagsAdded, 3); // m1: source:upload; m2: source:upload + type:jpg

  assert.deepEqual(t.added, [
    { mediaId: "m1", tags: ["source:upload"] },
    { mediaId: "m2", tags: ["source:upload", "type:jpg"] },
  ]);
  // Tag rows ensured for every distinct applied tag, then one reconcile pass.
  assert.deepEqual(new Set(t.ensured.flat()), new Set(["source:upload", "type:jpg"]));
  assert.deepEqual(t.reconciled, ["u1"]);
  assert.deepEqual(t.published, [{ userId: "u1", mediaId: "*", field: "tagsUpdated", value: "updated" }]);
});

test("organize: items already fully tagged are left untouched", async () => {
  const rows = [makeRow({ id: "m1", tags: ["type:pdf", "source:upload"] })];
  const t = makeDeps(rows);
  const { job } = makeJob({ userId: "u1", dryRun: false });

  const result = (await createOrganizeProcessor(t.deps)(job, "tok")) as OrganizeJobProgress;

  assert.equal(result.updated, 0);
  assert.deepEqual(t.added, []);
  // Nothing written → no reconcile, no event.
  assert.deepEqual(t.reconciled, []);
  assert.deepEqual(t.published, []);
});

test("organize: ingest source derives from sourcePath / isExtractedFromArchive", async () => {
  const rows = [
    makeRow({ id: "m1", sourcePath: "/roots/docs/a.pdf" }),
    makeRow({ id: "m2", isExtractedFromArchive: true }),
    makeRow({ id: "m3" }),
  ];
  const t = makeDeps(rows, { rules: [], indexRoots: ["/roots"] });
  const { job } = makeJob({ userId: "u1", dryRun: false });

  await createOrganizeProcessor(t.deps)(job, "tok");

  assert.deepEqual(t.added.map(a => a.tags), [["source:index"], ["source:unpacked"], ["source:upload"]]);
});

test("organize: folder and date tags for indexed items (metadata beats mtime)", async () => {
  const rows = [
    makeRow({
      id: "m1",
      filename: "scan.jpg",
      mimeType: "image/jpeg",
      sourcePath: "/roots/taxes/scan.jpg",
      metadata: { image: { capturedAt: "2020-07-01T00:00:00Z" } },
    }),
    // No embedded date → statFile mtime fallback.
    makeRow({ id: "m2", filename: "old.pdf", sourcePath: "/roots/receipts/old.pdf" }),
  ];
  const t = makeDeps(rows, { indexRoots: ["/roots"], mtimeMs: Date.UTC(2019, 2, 5) });
  const { job } = makeJob({ userId: "u1", dryRun: false });

  await createOrganizeProcessor(t.deps)(job, "tok");

  const byId = Object.fromEntries(t.added.map(a => [a.mediaId, a.tags]));
  assert.ok(byId.m1.includes("year:2020") && byId.m1.includes("month:2020-07"));
  assert.ok(byId.m1.includes("folder:taxes"));
  assert.ok(byId.m2.includes("year:2019"), `mtime fallback, got ${byId.m2}`);
});

test("organize: persists fileDate (backfill), skips unchanged values", async () => {
  const stored = new Date("2020-07-01T00:00:00Z");
  const rows = [
    // Embedded date, column empty → backfilled.
    makeRow({ id: "m1", metadata: { image: { capturedAt: "2020-07-01T00:00:00Z" } } }),
    // Embedded date matches the stored column → no redundant write.
    makeRow({ id: "m2", metadata: { image: { capturedAt: "2020-07-01T00:00:00Z" } }, fileDate: stored }),
    // No date anywhere → left null.
    makeRow({ id: "m3" }),
    // No embedded date but a sourcePath + null column → mtime stat fallback
    // fills the column even though FILE_DATE rules are disabled below.
    makeRow({ id: "m4", sourcePath: "/roots/a.pdf" }),
  ];
  const t = makeDeps(rows, { rules: [], indexRoots: ["/roots"], mtimeMs: Date.UTC(2019, 2, 5) });
  const { job } = makeJob({ userId: "u1", dryRun: false });

  await createOrganizeProcessor(t.deps)(job, "tok");

  const byId = Object.fromEntries(t.fileDates.map(f => [f.mediaId, f.fileDate]));
  assert.deepEqual(byId.m1, stored);
  assert.equal("m2" in byId, false, "unchanged fileDate must not be rewritten");
  assert.equal("m3" in byId, false, "no resolvable date leaves the column null");
  assert.deepEqual(byId.m4, new Date(Date.UTC(2019, 2, 5)));
});

test("organize: dry run never writes fileDate", async () => {
  const rows = [makeRow({ id: "m1", metadata: { image: { capturedAt: "2020-07-01T00:00:00Z" } } })];
  const t = makeDeps(rows);
  const { job } = makeJob({ userId: "u1", dryRun: true });

  await createOrganizeProcessor(t.deps)(job, "tok");

  assert.deepEqual(t.fileDates, []);
});

test("organize: dry run previews changes without writing", async () => {
  const rows = [makeRow({ id: "m1", title: "Doc One" }), makeRow({ id: "m2" })];
  const t = makeDeps(rows);
  const { job } = makeJob({ userId: "u1", dryRun: true });

  const result = (await createOrganizeProcessor(t.deps)(job, "tok")) as OrganizeJobProgress;

  assert.equal(result.dryRun, true);
  assert.equal(result.updated, 2);
  assert.ok(result.tagsAdded > 0);
  assert.equal(result.sample?.length, 2);
  assert.equal(result.sample?.[0]?.title, "Doc One");
  assert.ok((result.sample?.[0]?.addTags.length ?? 0) > 0);
  assert.ok(result.tagCounts["source:upload"] === 2);

  // Nothing persisted, no reconcile, no event.
  assert.deepEqual(t.added, []);
  assert.deepEqual(t.reconciled, []);
  assert.deepEqual(t.published, []);
});

test("organize: pages through the library in chunks and reports progress", async () => {
  const rows = Array.from({ length: 5 }, (_, i) => makeRow({ id: `m${i}` }));
  const t = makeDeps(rows, { chunkSize: 2 });
  const { job, progressUpdates } = makeJob({ userId: "u1", dryRun: false });

  const result = (await createOrganizeProcessor(t.deps)(job, "tok")) as OrganizeJobProgress;

  assert.equal(result.processed, 5);
  assert.equal(t.added.length, 5);
  // Initial update + one per chunk (3 chunks) + final.
  assert.ok(progressUpdates.length >= 4);
  const last = progressUpdates[progressUpdates.length - 1];
  assert.equal(last.processed, 5);
});

test("organize: a mid-run failure still reconciles what was committed", async () => {
  const rows = [makeRow({ id: "m1" }), makeRow({ id: "m2" })];
  const t = makeDeps(rows, { failAddFor: ["m2"] });
  const { job } = makeJob({ userId: "u1", dryRun: false });

  await assert.rejects(createOrganizeProcessor(t.deps)(job, "tok"));

  // m1 committed before the failure → the finally block still fixed counts.
  assert.equal(t.added.length, 1);
  assert.deepEqual(t.reconciled, ["u1"]);
  assert.equal(t.published.length, 1);
});
