import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { createMediaActionsService } from "@/services/media/mediaActionsService.js";

// ── mock builders ─────────────────────────────────────────────────────────────

type MediaKeys = { storageKey: string; thumbnailKey?: string | null };
type TextJobMedia = { id: string; storageKey: string; title?: string | null };
type BulkItem = { id: string; storageKey: string; title: string; mimeType: string | null; filename: string };

function makeRepo (overrides: {
  findMediaKeys?: (_userId: string, _id: string) => Promise<MediaKeys | null>;
  deleteMedia?: (_id: string) => Promise<void>;
  findMediaForUpdate?: (_userId: string, _id: string) => Promise<{ id: string } | null>;
  updateMetadata?: (_id: string, _data: unknown) => Promise<unknown>;
  findForTextJob?: (_userId: string, _id: string) => Promise<TextJobMedia | null>;
  setTextStatePending?: (_id: string) => Promise<void>;
  setTextState?: (_id: string, _state: string) => Promise<void>;
  findStorageKey?: (_userId: string, _id: string) => Promise<{ storageKey: string } | null>;
  resetThumbState?: (_id: string) => Promise<void>;
  findBulkDownloadItems?: (_userId: string, _ids: string[]) => Promise<BulkItem[]>;
} = {}) {
  return {
    findMediaKeys: overrides.findMediaKeys ?? (async () => null),
    deleteMedia: overrides.deleteMedia ?? (async () => {}),
    findMediaForUpdate: overrides.findMediaForUpdate ?? (async () => null),
    updateMetadata: overrides.updateMetadata ?? (async () => ({})),
    findForTextJob: overrides.findForTextJob ?? (async () => null),
    setTextStatePending: overrides.setTextStatePending ?? (async () => {}),
    setTextState: overrides.setTextState ?? (async () => {}),
    findStorageKey: overrides.findStorageKey ?? (async () => null),
    resetThumbState: overrides.resetThumbState ?? (async () => {}),
    findBulkDownloadItems: overrides.findBulkDownloadItems ?? (async () => []),
  } as unknown as Parameters<typeof createMediaActionsService>[0]["repository"];
}

function makeReadableStream (data = "file-bytes") {
  const s = new PassThrough();
  s.end(Buffer.from(data));
  return s;
}

function makeS3 (overrides: {
  deleteIfPresent?: (_args: unknown) => Promise<void>;
  presignGet?: (_args: unknown) => Promise<string>;
  getObjectStream?: (_args: unknown) => Promise<{ body: PassThrough; etag: null; contentLength: null } | null>;
} = {}) {
  return {
    deleteIfPresent: overrides.deleteIfPresent ?? (async () => {}),
    presignGet: overrides.presignGet ?? (async () => "https://example.com/presigned"),
    getObjectStream: overrides.getObjectStream ?? (async () => ({ body: makeReadableStream(), etag: null, contentLength: null })),
  } as unknown as Parameters<typeof createMediaActionsService>[0]["s3Adapter"];
}

function makeQueue (overrides: {
  getJob?: (_id: string) => Promise<unknown>;
  add?: (_name: string, _data: unknown, _opts?: unknown) => Promise<void>;
} = {}) {
  return {
    getJob: overrides.getJob ?? (async () => null),
    add: overrides.add ?? (async () => {}),
  } as unknown as Parameters<typeof createMediaActionsService>[0]["ocrQueue"];
}

function makeThumbQueue (overrides: {
  add?: (_name: string, _data: unknown, _opts?: unknown) => Promise<void>;
} = {}) {
  return {
    add: overrides.add ?? (async () => {}),
  } as unknown as Parameters<typeof createMediaActionsService>[0]["thumbQueue"];
}

function makeBundleRepo () {
  return {
    createBundle: async () => ({ id: "bundle-1" }),
    addItemsToBundle: async () => {},
    setCoverMedia: async () => {},
    setSourceMedia: async () => {},
    clearCoverMedia: async () => {},
  } as unknown as Parameters<typeof createMediaActionsService>[0]["bundleRepository"];
}

function makeService (repoOverrides = {}, s3Overrides = {}, ocrQueueOverrides = {}, thumbQueueOverrides = {}) {
  return createMediaActionsService({
    repository: makeRepo(repoOverrides),
    bundleRepository: makeBundleRepo(),
    s3Adapter: makeS3(s3Overrides),
    bucket: "test-bucket",
    ocrQueue: makeQueue(ocrQueueOverrides),
    thumbQueue: makeThumbQueue(thumbQueueOverrides),
  });
}

// ── deleteMedia ───────────────────────────────────────────────────────────────

test("deleteMedia: returns null when media not found", async () => {
  const svc = makeService();
  const result = await svc.deleteMedia("user-1", "no-such-id");
  assert.equal(result, null);
});

test("deleteMedia: deletes storage key from S3", async () => {
  const deleted: string[] = [];
  const svc = makeService(
    { findMediaKeys: async () => ({ storageKey: "users/u1/file.pdf" }) },
    { deleteIfPresent: async (args: unknown) => { deleted.push((args as { key: string }).key); } },
  );

  await svc.deleteMedia("user-1", "media-1");
  assert.ok(deleted.includes("users/u1/file.pdf"));
});

test("deleteMedia: also deletes thumbnail key when present", async () => {
  const deleted: string[] = [];
  const svc = makeService(
    { findMediaKeys: async () => ({ storageKey: "orig/key", thumbnailKey: "thumbs/media-1.webp" }) },
    { deleteIfPresent: async (args: unknown) => { deleted.push((args as { key: string }).key); } },
  );

  await svc.deleteMedia("user-1", "media-1");
  assert.ok(deleted.includes("orig/key"));
  assert.ok(deleted.includes("thumbs/media-1.webp"));
});

test("deleteMedia: skips thumbnail delete when thumbnailKey is null", async () => {
  const deleted: string[] = [];
  const svc = makeService(
    { findMediaKeys: async () => ({ storageKey: "orig/key", thumbnailKey: null }) },
    { deleteIfPresent: async (args: unknown) => { deleted.push((args as { key: string }).key); } },
  );

  await svc.deleteMedia("user-1", "media-1");
  assert.equal(deleted.length, 1);
  assert.equal(deleted[0], "orig/key");
});

test("deleteMedia: calls repository.deleteMedia after S3 deletes", async () => {
  const callOrder: string[] = [];
  const svc = makeService(
    {
      findMediaKeys: async () => ({ storageKey: "k" }),
      deleteMedia: async () => { callOrder.push("db"); },
    },
    { deleteIfPresent: async () => { callOrder.push("s3"); } },
  );

  await svc.deleteMedia("u", "m");
  assert.ok(callOrder.indexOf("s3") < callOrder.indexOf("db"), "S3 delete before DB delete");
});

test("deleteMedia: returns { ok: true } on success", async () => {
  const svc = makeService(
    { findMediaKeys: async () => ({ storageKey: "k" }) },
  );
  const result = await svc.deleteMedia("u", "m");
  assert.deepEqual(result, { ok: true });
});

// ── updateMediaMetadata ───────────────────────────────────────────────────────

test("updateMediaMetadata: returns null when media not found", async () => {
  const svc = makeService();
  const result = await svc.updateMediaMetadata("u", "m", { title: "New" });
  assert.equal(result, null);
});

test("updateMediaMetadata: calls updateMetadata with the provided data", async () => {
  let updatedWith: unknown = null;
  const svc = makeService({
    findMediaForUpdate: async () => ({ id: "m1" }),
    updateMetadata: async (_id: string, data: unknown) => { updatedWith = data; return {}; },
  });

  await svc.updateMediaMetadata("u", "m1", { title: "My Doc", tags: ["a", "b"] });
  assert.deepEqual(updatedWith, { title: "My Doc", tags: ["a", "b"] });
});

// ── enqueueTextExtraction ─────────────────────────────────────────────────────

test("enqueueTextExtraction: returns null when media not found", async () => {
  const svc = makeService();
  const result = await svc.enqueueTextExtraction("u", "m", {});
  assert.equal(result, null);
});

test("enqueueTextExtraction: adds job to queue with correct mediaId", async () => {
  const jobs: unknown[] = [];
  const svc = makeService(
    { findForTextJob: async () => ({ id: "m1", storageKey: "k", title: "Doc" }) },
    {},
    {
      getJob: async () => null,
      add: async (_name: string, data: unknown) => { jobs.push(data); },
    },
  );

  await svc.enqueueTextExtraction("u", "m1", {});
  assert.equal(jobs.length, 1);
  assert.equal((jobs[0] as { mediaId: string }).mediaId, "m1");
});

test("enqueueTextExtraction: removes stale job before re-queueing", async () => {
  let removed = false;
  const staleJob = { remove: async () => { removed = true; } };

  const svc = makeService(
    { findForTextJob: async () => ({ id: "m1", storageKey: "k" }) },
    {},
    {
      getJob: async () => staleJob,
      add: async () => {},
    },
  );

  await svc.enqueueTextExtraction("u", "m1", {});
  assert.equal(removed, true);
});

test("enqueueTextExtraction: sets textState to PENDING", async () => {
  let pendingSet = false;
  const svc = makeService(
    {
      findForTextJob: async () => ({ id: "m1", storageKey: "k" }),
      setTextStatePending: async () => { pendingSet = true; },
    },
    {},
    { getJob: async () => null, add: async () => {} },
  );

  await svc.enqueueTextExtraction("u", "m1", {});
  assert.equal(pendingSet, true);
});

test("enqueueTextExtraction: forwards language and rotation options", async () => {
  const jobs: unknown[] = [];
  const svc = makeService(
    { findForTextJob: async () => ({ id: "m1", storageKey: "k" }) },
    {},
    {
      getJob: async () => null,
      add: async (_name: string, data: unknown) => { jobs.push(data); },
    },
  );

  await svc.enqueueTextExtraction("u", "m1", { language: "deu", rotation: "90" });
  const job = jobs[0] as { language: string; rotation: string };
  assert.equal(job.language, "deu");
  assert.equal(job.rotation, "90");
});

test("enqueueTextExtraction: returns { ok: true } on success", async () => {
  const svc = makeService(
    { findForTextJob: async () => ({ id: "m1", storageKey: "k" }) },
    {},
    { getJob: async () => null, add: async () => {} },
  );
  const result = await svc.enqueueTextExtraction("u", "m1", {});
  assert.deepEqual(result, { ok: true });
});

// ── cancelTextExtraction ──────────────────────────────────────────────────────

test("cancelTextExtraction: returns null when media not found", async () => {
  const svc = makeService();
  const result = await svc.cancelTextExtraction("u", "m");
  assert.equal(result, null);
});

test("cancelTextExtraction: removes active job and sets textState to ERROR", async () => {
  let removed = false;
  let stateSet: string | null = null;
  const activeJob = { remove: async () => { removed = true; } };

  const svc = makeService(
    {
      findForTextJob: async () => ({ id: "m1", storageKey: "k" }),
      setTextState: async (_id: string, state: string) => { stateSet = state; },
    },
    {},
    { getJob: async () => activeJob },
  );

  await svc.cancelTextExtraction("u", "m1");
  assert.equal(removed, true);
  assert.equal(stateSet, "ERROR");
});

test("cancelTextExtraction: sets textState to ERROR even when no active job exists", async () => {
  let stateSet: string | null = null;
  const svc = makeService(
    {
      findForTextJob: async () => ({ id: "m1", storageKey: "k" }),
      setTextState: async (_id: string, state: string) => { stateSet = state; },
    },
    {},
    { getJob: async () => null },
  );

  await svc.cancelTextExtraction("u", "m1");
  assert.equal(stateSet, "ERROR");
});

// ── getDownloadUrl ────────────────────────────────────────────────────────────

test("getDownloadUrl: returns null when media not found", async () => {
  const svc = makeService();
  const result = await svc.getDownloadUrl("u", "m");
  assert.equal(result, null);
});

test("getDownloadUrl: returns presigned URL from S3 adapter", async () => {
  const svc = makeService(
    { findStorageKey: async () => ({ storageKey: "users/u/file.pdf" }) },
    { presignGet: async () => "https://s3.example.com/signed-url" },
  );

  const result = await svc.getDownloadUrl("u", "m1");
  assert.equal(result?.url, "https://s3.example.com/signed-url");
});

// ── regenerateThumbnail ───────────────────────────────────────────────────────

test("regenerateThumbnail: returns null when media not found", async () => {
  const svc = makeService();
  const result = await svc.regenerateThumbnail("u", "m");
  assert.equal(result, null);
});

test("regenerateThumbnail: resets thumb state and enqueues a thumb job", async () => {
  let thumbReset = false;
  const thumbJobs: unknown[] = [];

  const svc = makeService(
    {
      findMediaKeys: async () => ({ storageKey: "orig/key" }),
      resetThumbState: async () => { thumbReset = true; },
    },
    {},
    {},
    { add: async (_name: string, data: unknown) => { thumbJobs.push(data); } },
  );

  const result = await svc.regenerateThumbnail("u", "media-1");
  assert.equal(thumbReset, true);
  assert.equal(thumbJobs.length, 1);
  const job = thumbJobs[0] as { mediaId: string; storageKey: string };
  assert.equal(job.mediaId, "media-1");
  assert.equal(job.storageKey, "orig/key");
  assert.deepEqual(result, { ok: true });
});

// ── getBulkDownloadItems ──────────────────────────────────────────────────────

test("getBulkDownloadItems: returns empty array when no owned items found", async () => {
  const svc = makeService();
  const result = await svc.getBulkDownloadItems("u", ["id-1", "id-2"]);
  assert.deepEqual(result, []);
});

test("getBulkDownloadItems: forwards userId and ids to repository", async () => {
  let calledWith: { userId: string; ids: string[] } | null = null;
  const svc = makeService({
    findBulkDownloadItems: async (userId: string, ids: string[]) => {
      calledWith = { userId, ids };
      return [];
    },
  });

  await svc.getBulkDownloadItems("user-42", ["a", "b", "c"]);
  assert.deepEqual(calledWith, { userId: "user-42", ids: ["a", "b", "c"] });
});

test("getBulkDownloadItems: returns items from repository", async () => {
  const items: BulkItem[] = [
    { id: "m1", storageKey: "k1", title: "Photo", mimeType: "image/jpeg", filename: "photo.jpg" },
    { id: "m2", storageKey: "k2", title: "Doc", mimeType: "application/pdf", filename: "doc.pdf" },
  ];
  const svc = makeService({ findBulkDownloadItems: async () => items });
  const result = await svc.getBulkDownloadItems("u", ["m1", "m2"]);
  assert.deepEqual(result, items);
});

// ── streamBulkArchive ─────────────────────────────────────────────────────────

function collectStream (dest: PassThrough): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    dest.on("data", (chunk: Buffer) => chunks.push(chunk));
    dest.on("end", () => resolve(Buffer.concat(chunks)));
    dest.on("error", reject);
  });
}

const noopLogger = { error: () => {} };

test("streamBulkArchive: produces non-empty zip output", async () => {
  const items: BulkItem[] = [
    { id: "m1", storageKey: "k1", title: "Photo", mimeType: "image/jpeg", filename: "photo.jpg" },
  ];
  const svc = makeService({}, { getObjectStream: async () => ({ body: makeReadableStream("image-data"), etag: null, contentLength: null }) });

  const dest = new PassThrough();
  const collected = collectStream(dest);
  await svc.streamBulkArchive(items, dest, noopLogger, []);
  const buf = await collected;

  // Zip files begin with the PK magic bytes (0x50 0x4B)
  assert.ok(buf.length > 0, "output is non-empty");
  assert.equal(buf[0], 0x50, "starts with P (zip magic)");
  assert.equal(buf[1], 0x4b, "starts with K (zip magic)");
});

test("streamBulkArchive: calls getObjectStream for each item", async () => {
  const keys: string[] = [];
  const items: BulkItem[] = [
    { id: "m1", storageKey: "key/a", title: "A", mimeType: "image/png", filename: "a.png" },
    { id: "m2", storageKey: "key/b", title: "B", mimeType: "image/png", filename: "b.png" },
  ];
  const svc = makeService({}, {
    getObjectStream: async (args: unknown) => {
      keys.push((args as { key: string }).key);
      return { body: makeReadableStream(), etag: null, contentLength: null };
    },
  });

  const dest = new PassThrough();
  await svc.streamBulkArchive(items, dest, noopLogger, []);

  assert.deepEqual(keys, ["key/a", "key/b"]);
});

test("streamBulkArchive: skips items where S3 returns null", async () => {
  const items: BulkItem[] = [
    { id: "missing", storageKey: "gone", title: "Gone", mimeType: null, filename: "gone.txt" },
    { id: "present", storageKey: "here", title: "Here", mimeType: "text/plain", filename: "here.txt" },
  ];
  let streamCalls = 0;
  const svc = makeService({}, {
    getObjectStream: async (args: unknown) => {
      streamCalls++;
      const key = (args as { key: string }).key;
      if (key === "gone") return null;
      return { body: makeReadableStream("content"), etag: null, contentLength: null };
    },
  });

  const dest = new PassThrough();
  const collected = collectStream(dest);
  await svc.streamBulkArchive(items, dest, noopLogger, []);
  const buf = await collected;

  assert.equal(streamCalls, 2, "attempted both items");
  assert.ok(buf.length > 0, "still produced a zip (from the present item)");
});

test("streamBulkArchive: deduplicates filenames when two items share a title", async () => {
  // We verify deduplication indirectly: the archive must finalize without error,
  // meaning archiver accepted two distinct entry names (no collision crash).
  const items: BulkItem[] = [
    { id: "m1", storageKey: "k1", title: "Report", mimeType: "application/pdf", filename: "report.pdf" },
    { id: "m2", storageKey: "k2", title: "Report", mimeType: "application/pdf", filename: "report2.pdf" },
  ];
  const svc = makeService({}, {
    getObjectStream: async () => ({ body: makeReadableStream("data"), etag: null, contentLength: null }),
  });

  const dest = new PassThrough();
  const collected = collectStream(dest);
  await svc.streamBulkArchive(items, dest, noopLogger, []);
  const buf = await collected;

  // Zip contains both entries — a zip with 2 files is always larger than one with 1
  assert.ok(buf.length > 0);
  // The central directory contains filenames; check both expected names appear in the raw bytes
  const content = buf.toString("binary");
  assert.ok(content.includes("Report.pdf"), "first entry has plain name");
  assert.ok(content.includes("Report_2.pdf"), "second entry has deduplicated name");
});

test("streamBulkArchive: falls back to original filename extension for unknown mimeType", async () => {
  const items: BulkItem[] = [
    { id: "m1", storageKey: "k1", title: "Mystery", mimeType: "application/octet-stream", filename: "mystery.dat" },
  ];
  const svc = makeService({}, {
    getObjectStream: async () => ({ body: makeReadableStream(), etag: null, contentLength: null }),
  });

  const dest = new PassThrough();
  const collected = collectStream(dest);
  await svc.streamBulkArchive(items, dest, noopLogger, []);
  const buf = await collected;

  assert.ok(buf.toString("binary").includes("Mystery.dat"), "uses extension from original filename");
});

test("streamBulkArchive: falls back to original filename extension when mimeType is null", async () => {
  const items: BulkItem[] = [
    { id: "m1", storageKey: "k1", title: "NoType", mimeType: null, filename: "notype.heic" },
  ];
  const svc = makeService({}, {
    getObjectStream: async () => ({ body: makeReadableStream(), etag: null, contentLength: null }),
  });

  const dest = new PassThrough();
  const collected = collectStream(dest);
  await svc.streamBulkArchive(items, dest, noopLogger, []);
  const buf = await collected;

  assert.ok(buf.toString("binary").includes("NoType.heic"), "uses extension from original filename");
});

test("streamBulkArchive: produces no extension when mimeType and filename both lack one", async () => {
  const items: BulkItem[] = [
    { id: "m1", storageKey: "k1", title: "Bare", mimeType: null, filename: "bare" },
  ];
  const svc = makeService({}, {
    getObjectStream: async () => ({ body: makeReadableStream(), etag: null, contentLength: null }),
  });

  const dest = new PassThrough();
  const collected = collectStream(dest);
  await svc.streamBulkArchive(items, dest, noopLogger, []);
  const buf = await collected;

  // Entry is stored as just "Bare" with no extension
  assert.ok(buf.toString("binary").includes("Bare"), "entry exists");
  assert.ok(!buf.toString("binary").includes("Bare."), "no spurious extension appended");
});

test("streamBulkArchive: falls back to item id when title sanitizes to empty string", async () => {
  const items: BulkItem[] = [
    { id: "abc-123", storageKey: "k1", title: "///", mimeType: "image/png", filename: "img.png" },
  ];
  const svc = makeService({}, {
    getObjectStream: async () => ({ body: makeReadableStream(), etag: null, contentLength: null }),
  });

  const dest = new PassThrough();
  const collected = collectStream(dest);
  await svc.streamBulkArchive(items, dest, noopLogger, []);
  const buf = await collected;

  assert.ok(buf.toString("binary").includes("abc-123.png"), "falls back to item id");
});
