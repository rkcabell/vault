import test from "node:test";
import assert from "node:assert/strict";
import { createMediaUploadService } from "@/services/media/mediaUploadService.js";
import { DEFAULT_TAG_RULES } from "@/lib/tags/rules/defaults.js";

type Deps = Parameters<typeof createMediaUploadService>[0];

// The seeded default rule set (type:, year:, month:, folder:), as the service
// receives it from tagRuleRepository.listEnabled.
const defaultRules = DEFAULT_TAG_RULES.map(r => ({ ...r, enabled: true }));

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Deps["logger"];

// ── mock builders ─────────────────────────────────────────────────────────────

function makeRepo (overrides: {
  createMedia?: (_data: unknown, _opts?: { autoTags?: string[] }) => Promise<{ id: string; storageKey: string }>;
  createBatch?: (_items: unknown[]) => Promise<void>;
  markSourcesReady?: (_userId: string, _ids: string[]) => Promise<{ id: string; storageKey: string; mimeType: string; sizeBytes?: number }[]>;
  markTextUnsupported?: (_ids: string[]) => Promise<void>;
  markThumbUnsupported?: (_ids: string[]) => Promise<void>;
  markThumbTooLarge?: (_ids: string[]) => Promise<void>;
} = {}): Deps["repository"] {
  return {
    createMedia: overrides.createMedia ?? (async (data: unknown) => {
      const d = data as { id: string; storageKey: string };
      return { id: d.id, storageKey: d.storageKey };
    }),
    createBatch: overrides.createBatch ?? (async () => {}),
    markSourcesReady: overrides.markSourcesReady ?? (async () => []),
    markTextUnsupported: overrides.markTextUnsupported ?? (async () => {}),
    markThumbUnsupported: overrides.markThumbUnsupported ?? (async () => {}),
    markThumbTooLarge: overrides.markThumbTooLarge ?? (async () => {}),
  } as unknown as Deps["repository"];
}

function makeS3 (overrides: {
  presignPut?: (_args: unknown) => Promise<string>;
} = {}): Deps["storage"] {
  return {
    presignPut: overrides.presignPut ?? (async () => "https://s3.example.com/put-url"),
  } as unknown as Deps["storage"];
}

function makeQueue (overrides: {
  addBulk?: (_jobs: unknown[]) => Promise<void>;
} = {}) {
  return {
    addBulk: overrides.addBulk ?? (async () => {}),
  };
}

function makeService (
  repoOverrides: Parameters<typeof makeRepo>[0] = {},
  s3Overrides: Parameters<typeof makeS3>[0] = {},
  queueOverrides: Parameters<typeof makeQueue>[0] = {},
) {
  const queue = makeQueue(queueOverrides);
  return createMediaUploadService({
    repository: makeRepo(repoOverrides),
    storage: makeS3(s3Overrides),
    bucket: "test-bucket",
    thumbQueue: queue as unknown as Deps["thumbQueue"],
    ocrQueue: queue as unknown as Deps["ocrQueue"],
    listTagRules: async () => defaultRules,
    logger,
  });
}

// ── initUpload ────────────────────────────────────────────────────────────────

test("initUpload: returns an id, uploadUrl, and storageKey", async () => {
  const svc = makeService();
  const result = await svc.initUpload("user-1", {
    filename: "doc.pdf",
    mimeType: "application/pdf",
    sizeBytes: 1024,
    title: "My Document",
    tags: [],
  });

  assert.ok(typeof result.id === "string" && result.id.length > 0);
  assert.ok(typeof result.uploadUrl === "string" && result.uploadUrl.length > 0);
  assert.ok(typeof result.storageKey === "string" && result.storageKey.length > 0);
});

test("initUpload: storageKey includes userId and filename", async () => {
  const svc = makeService();
  const result = await svc.initUpload("user-1", {
    filename: "report.pdf",
    mimeType: "application/pdf",
    sizeBytes: 0,
    title: "Report",
    tags: [],
  });

  assert.ok(result.storageKey.includes("user-1"));
  assert.ok(result.storageKey.includes("report.pdf"));
});

test("initUpload: adds the rule-derived type and source tags", async () => {
  const tags: string[][] = [];
  const svc = makeService({
    createMedia: async (data) => {
      const d = data as { id: string; storageKey: string; tags: string[] };
      tags.push(d.tags);
      return { id: d.id, storageKey: d.storageKey };
    },
  });

  await svc.initUpload("u", {
    filename: "photo.jpg",
    mimeType: "image/jpeg",
    sizeBytes: 0,
    title: "Photo",
    tags: ["vacation"],
  });

  assert.ok(tags[0]?.includes("vacation"));
  assert.ok(tags[0]?.includes("type:jpg"), "MIME rule tag applied");
  assert.ok(tags[0]?.includes("source:upload"), "built-in source axis applied");
});

test("initUpload: marks rule tags as auto but not user-supplied tags", async () => {
  let captured: { tags?: string[]; autoTags?: string[] } = {};
  const svc = makeService({
    createMedia: async (data: unknown, opts?: { autoTags?: string[] }) => {
      const d = data as { id: string; storageKey: string; tags: string[] };
      captured = { tags: d.tags, autoTags: opts?.autoTags };
      return { id: d.id, storageKey: d.storageKey };
    },
  });

  await svc.initUpload("u", {
    filename: "photo.jpg",
    mimeType: "image/jpeg",
    sizeBytes: 0,
    title: "Photo",
    tags: ["vacation"],
  });

  assert.ok(captured.autoTags?.includes("type:jpg"), "MIME rule tag is auto");
  assert.ok(captured.autoTags?.includes("source:upload"), "source axis is auto");
  assert.ok(captured.tags?.includes("vacation"));
  assert.ok(!captured.autoTags?.includes("vacation"), "user tag is not auto");
});

test("initUpload: a user-typed tag matching a rule tag is not treated as auto", async () => {
  let captured: { autoTags?: string[] } = {};
  const svc = makeService({
    createMedia: async (data: unknown, opts?: { autoTags?: string[] }) => {
      const d = data as { id: string; storageKey: string };
      captured = { autoTags: opts?.autoTags };
      return { id: d.id, storageKey: d.storageKey };
    },
  });

  await svc.initUpload("u", {
    filename: "photo.jpg",
    mimeType: "image/jpeg",
    sizeBytes: 0,
    title: "Photo",
    tags: ["type:jpg"],
  });

  assert.ok(!captured.autoTags?.includes("type:jpg"), "user intent wins; type:jpg is not auto");
  assert.ok(captured.autoTags?.includes("source:upload"), "other rule tags stay auto");
});

test("initUpload: autoTagOnUpload=false skips every rule tag", async () => {
  let captured: { tags?: string[]; autoTags?: string[] } = {};
  const svc = makeService({
    createMedia: async (data: unknown, opts?: { autoTags?: string[] }) => {
      const d = data as { id: string; storageKey: string; tags: string[] };
      captured = { tags: d.tags, autoTags: opts?.autoTags };
      return { id: d.id, storageKey: d.storageKey };
    },
  });

  await svc.initUpload("u", {
    filename: "photo.jpg",
    mimeType: "image/jpeg",
    sizeBytes: 0,
    title: "Photo",
    tags: ["vacation"],
    autoTagOnUpload: false,
  });

  assert.deepEqual(captured.tags, ["vacation"]);
  assert.deepEqual(captured.autoTags, []);
});

test("initUpload: deduplicates tags", async () => {
  const tags: string[][] = [];
  const svc = makeService({
    createMedia: async (data) => {
      const d = data as { id: string; storageKey: string; tags: string[] };
      tags.push(d.tags);
      return { id: d.id, storageKey: d.storageKey };
    },
  });

  await svc.initUpload("u", {
    filename: "f.pdf",
    mimeType: "application/pdf",
    sizeBytes: 0,
    title: "F",
    tags: ["application-pdf", "application-pdf"],
  });

  const unique = new Set(tags[0]);
  assert.equal(unique.size, tags[0]?.length, "tags should be unique");
});

test("initUpload: requests a presigned PUT URL from S3", async () => {
  const presignCalls: unknown[] = [];
  const svc = makeService(
    {},
    { presignPut: async (args) => { presignCalls.push(args); return "https://signed"; } },
  );

  await svc.initUpload("u", {
    filename: "f.txt", mimeType: "text/plain", sizeBytes: 0, title: "F", tags: [],
  });

  assert.equal(presignCalls.length, 1);
  const call = presignCalls[0] as { bucket: string; contentType: string };
  assert.equal(call.bucket, "test-bucket");
  assert.equal(call.contentType, "text/plain");
});

// ── initBatchUploads ──────────────────────────────────────────────────────────

test("initBatchUploads: returns one signed item per input item", async () => {
  const svc = makeService();
  const result = await svc.initBatchUploads("user-1", [
    { filename: "a.pdf", mimeType: "application/pdf", sizeBytes: 100, tags: [] },
    { filename: "b.jpg", mimeType: "image/jpeg", sizeBytes: 200, tags: [] },
  ]);

  assert.equal(result.items.length, 2);
});

test("initBatchUploads: each item has id, storageKey, and putUrl", async () => {
  const svc = makeService();
  const result = await svc.initBatchUploads("u", [
    { filename: "file.pdf", mimeType: "application/pdf", sizeBytes: 0, tags: [] },
  ]);

  const item = result.items[0]!;
  assert.ok(typeof item.id === "string" && item.id.length > 0);
  assert.ok(typeof item.storageKey === "string" && item.storageKey.includes("file.pdf"));
  assert.ok(typeof item.putUrl === "string");
});

test("initBatchUploads: derives title from filename when title is null", async () => {
  const batches: unknown[] = [];
  const svc = makeService({
    createBatch: async (items) => { batches.push(items); },
  });

  await svc.initBatchUploads("u", [
    { filename: "my-report.pdf", mimeType: "application/pdf", sizeBytes: 0, title: null, tags: [] },
  ]);

  const items = batches[0] as Array<{ title: string }>;
  assert.equal(items[0]?.title, "my-report");
});

test("initBatchUploads: uses provided title when not null", async () => {
  const batches: unknown[] = [];
  const svc = makeService({ createBatch: async (items) => { batches.push(items); } });

  await svc.initBatchUploads("u", [
    { filename: "f.pdf", mimeType: "application/pdf", sizeBytes: 0, title: "Custom Title", tags: [] },
  ]);

  const items = batches[0] as Array<{ title: string }>;
  assert.equal(items[0]?.title, "Custom Title");
});

test("initBatchUploads: creates a presigned PUT URL for each item", async () => {
  const presignCalls: unknown[] = [];
  const svc = makeService(
    {},
    { presignPut: async (args) => { presignCalls.push(args); return "https://signed"; } },
  );

  await svc.initBatchUploads("u", [
    { filename: "a.pdf", mimeType: "application/pdf", sizeBytes: 0, tags: [] },
    { filename: "b.jpg", mimeType: "image/jpeg", sizeBytes: 0, tags: [] },
  ]);

  assert.equal(presignCalls.length, 2);
});

// ── finalizeBatch ─────────────────────────────────────────────────────────────

test("finalizeBatch: returns ok:true and count:0 for empty ids", async () => {
  const svc = makeService();
  const result = await svc.finalizeBatch("u", []);
  assert.deepEqual(result, { ok: true, count: 0 });
});

test("finalizeBatch: returns ok:true and count:0 when no media found for ids", async () => {
  const svc = makeService({ markSourcesReady: async () => [] });
  const result = await svc.finalizeBatch("u", ["id-1", "id-2"]);
  assert.deepEqual(result, { ok: true, count: 0 });
});

test("finalizeBatch: returns count equal to number of items marked ready", async () => {
  const svc = makeService({
    markSourcesReady: async () => [
      { id: "a", storageKey: "k/a", mimeType: "image/jpeg" },
      { id: "b", storageKey: "k/b", mimeType: "image/jpeg" },
    ],
  });

  const result = await svc.finalizeBatch("u", ["a", "b"]);
  assert.deepEqual(result, { ok: true, count: 2 });
});

test("finalizeBatch: deduplicates ids before passing to repository", async () => {
  const seenIds: string[][] = [];
  const svc = makeService({
    markSourcesReady: async (_userId, ids) => { seenIds.push(ids); return []; },
  });

  await svc.finalizeBatch("u", ["x", "x", "y", "x"]);
  assert.equal(seenIds[0]?.length, 2);
  assert.ok(seenIds[0]?.includes("x"));
  assert.ok(seenIds[0]?.includes("y"));
});

test("finalizeBatch: enqueues thumb and OCR jobs for each ready item", async () => {
  const thumbBulks: unknown[][] = [];
  const ocrBulks: unknown[][] = [];

  const svc = createMediaUploadService({
    repository: makeRepo({
      markSourcesReady: async () => [
        { id: "m1", storageKey: "k/m1", mimeType: "image/jpeg" },
        { id: "m2", storageKey: "k/m2", mimeType: "image/jpeg" },
      ],
    }),
    storage: makeS3(),
    bucket: "test-bucket",
    listTagRules: async () => [],
    thumbQueue: { addBulk: async (jobs: unknown[]) => { thumbBulks.push(jobs); } } as unknown as Deps["thumbQueue"],
    ocrQueue: { addBulk: async (jobs: unknown[]) => { ocrBulks.push(jobs); } } as unknown as Deps["ocrQueue"],
    logger,
  });

  await svc.finalizeBatch("u", ["m1", "m2"]);

  assert.equal(thumbBulks[0]?.length, 2);
  assert.equal(ocrBulks[0]?.length, 2);
});

test("finalizeBatch: only enqueues thumb/OCR for compatible types, marks the rest FAILED", async () => {
  const thumbBulks: { data: { mediaId: string } }[][] = [];
  const ocrBulks: { data: { mediaId: string } }[][] = [];
  let textUnsupported: string[] | null = null;
  let thumbUnsupported: string[] | null = null;

  const svc = createMediaUploadService({
    repository: makeRepo({
      markSourcesReady: async () => [
        { id: "img", storageKey: "k/img", mimeType: "image/jpeg" }, // thumb + ocr
        { id: "vid", storageKey: "k/vid", mimeType: "video/mp4" },  // thumb only
        { id: "txt", storageKey: "k/txt", mimeType: "text/plain" }, // neither
      ],
      markTextUnsupported: async (ids: string[]) => { textUnsupported = ids; },
      markThumbUnsupported: async (ids: string[]) => { thumbUnsupported = ids; },
    }),
    storage: makeS3(),
    bucket: "test-bucket",
    listTagRules: async () => [],
    thumbQueue: { addBulk: async (jobs: unknown[]) => { thumbBulks.push(jobs as { data: { mediaId: string } }[]); } } as unknown as Deps["thumbQueue"],
    ocrQueue: { addBulk: async (jobs: unknown[]) => { ocrBulks.push(jobs as { data: { mediaId: string } }[]); } } as unknown as Deps["ocrQueue"],
    logger,
  });

  await svc.finalizeBatch("u", ["img", "vid", "txt"]);

  // Thumb: image + video (not txt). Text extraction: image (OCR) + txt (direct read).
  assert.deepEqual(thumbBulks[0]?.map(j => j.data.mediaId).sort(), ["img", "vid"]);
  assert.deepEqual(ocrBulks[0]?.map(j => j.data.mediaId).sort(), ["img", "txt"]);
  // Text-unsupported: video only. Thumb-unsupported: txt only.
  assert.deepEqual((textUnsupported as string[] | null)?.sort(), ["vid"]);
  assert.deepEqual(thumbUnsupported as string[] | null, ["txt"]);
});

test("finalizeBatch: does NOT enqueue a thumb for an oversize file, marks it too-large", async () => {
  const GIB = 1024 * 1024 * 1024;
  const thumbBulks: { data: { mediaId: string } }[][] = [];
  let thumbTooLarge: string[] | null = null;

  const svc = createMediaUploadService({
    repository: makeRepo({
      markSourcesReady: async () => [
        { id: "small", storageKey: "k/small", mimeType: "video/mp4", sizeBytes: 100 * 1024 * 1024 },
        { id: "huge", storageKey: "k/huge", mimeType: "video/mp4", sizeBytes: 3 * GIB }, // > 2 GiB
      ],
      markThumbTooLarge: async (ids: string[]) => { thumbTooLarge = ids; },
    }),
    storage: makeS3(),
    bucket: "test-bucket",
    listTagRules: async () => [],
    thumbQueue: { addBulk: async (jobs: unknown[]) => { thumbBulks.push(jobs as { data: { mediaId: string } }[]); } } as unknown as Deps["thumbQueue"],
    ocrQueue: { addBulk: async () => {} } as unknown as Deps["ocrQueue"],
    logger,
  });

  await svc.finalizeBatch("u", ["small", "huge"]);

  // Only the small file is queued for a thumbnail; the huge one is skipped + marked.
  assert.deepEqual(thumbBulks[0]?.map(j => j.data.mediaId), ["small"]);
  assert.deepEqual(thumbTooLarge as string[] | null, ["huge"]);
});
