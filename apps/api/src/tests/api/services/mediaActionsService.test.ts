import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Readable } from "node:stream";
import archiver from "archiver";
import { createMediaActionsService } from "@/services/media/mediaActionsService.js";

// ── mock builders ─────────────────────────────────────────────────────────────

type MediaKeys = { storageKey: string; thumbnailKey?: string | null; sourcePath?: string | null; mimeType?: string | null };
type TextJobMedia = { id: string; storageKey: string; title?: string | null; sourcePath?: string | null; mimeType?: string | null };
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
  markThumbUnsupported?: (_ids: string[]) => Promise<void>;
  markTextUnsupported?: (_ids: string[]) => Promise<void>;
  findDetail?: (_userId: string, _id: string) => Promise<unknown>;
  createMedia?: (_data: unknown) => Promise<{ id: string; storageKey: string }>;
  setLinkedBundle?: (_mediaId: string, _bundleId: string) => Promise<void>;
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
    markThumbUnsupported: overrides.markThumbUnsupported ?? (async () => {}),
    markTextUnsupported: overrides.markTextUnsupported ?? (async () => {}),
    findDetail: overrides.findDetail ?? (async () => null),
    createMedia: overrides.createMedia ?? (async (data: unknown) => {
      const d = data as { id: string; storageKey: string };
      return { id: d.id, storageKey: d.storageKey };
    }),
    setLinkedBundle: overrides.setLinkedBundle ?? (async () => {}),
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
  } as unknown as Parameters<typeof createMediaActionsService>[0]["storage"];
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
  getJob?: (_id: string) => Promise<unknown>;
  add?: (_name: string, _data: unknown, _opts?: unknown) => Promise<void>;
} = {}) {
  return {
    getJob: overrides.getJob ?? (async () => null),
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
    storage: makeS3(s3Overrides),
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

test("enqueueTextExtraction: in-place item carries allowedRoots", async () => {
  const jobs: unknown[] = [];
  const svc = makeService(
    { findForTextJob: async () => ({ id: "m1", storageKey: "external/u/m/doc.pdf", sourcePath: "C:\\nas\\doc.pdf" }) },
    {},
    {
      getJob: async () => null,
      add: async (_name: string, data: unknown) => { jobs.push(data); },
    },
  );

  await svc.enqueueTextExtraction("u", "m1", {}, ["C:\\nas"]);
  const job = jobs[0] as { allowedRoots?: string[] };
  assert.deepEqual(job.allowedRoots, ["C:\\nas"]);
});

test("enqueueTextExtraction: managed item does not carry allowedRoots", async () => {
  const jobs: unknown[] = [];
  const svc = makeService(
    { findForTextJob: async () => ({ id: "m1", storageKey: "k", sourcePath: null }) },
    {},
    {
      getJob: async () => null,
      add: async (_name: string, data: unknown) => { jobs.push(data); },
    },
  );

  await svc.enqueueTextExtraction("u", "m1", {}, ["C:\\nas"]);
  const job = jobs[0] as { allowedRoots?: string[] };
  assert.equal(job.allowedRoots, undefined);
});

test("enqueueTextExtraction: marks unsupported file types (audio/mpeg) as unsupported", async () => {
  let unsupportedIds: string[] = [];
  const jobs: unknown[] = [];
  const svc = makeService(
    {
      findForTextJob: async () => ({ id: "m1", storageKey: "k", mimeType: "audio/mpeg" }),
      markTextUnsupported: async (ids: string[]) => { unsupportedIds = ids; },
    },
    {},
    {
      getJob: async () => null,
      add: async (_name: string, data: unknown) => { jobs.push(data); },
    },
  );

  const result = await svc.enqueueTextExtraction("u", "m1", {});
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(unsupportedIds, ["m1"]);
  assert.equal(jobs.length, 0);
});

test("enqueueTextExtraction: still queues supported file types (PDF)", async () => {
  let unsupportedIds: string[] = [];
  const jobs: unknown[] = [];
  const svc = makeService(
    {
      findForTextJob: async () => ({ id: "m1", storageKey: "k", mimeType: "application/pdf" }),
      markTextUnsupported: async (ids: string[]) => { unsupportedIds = ids; },
      setTextStatePending: async () => {},
    },
    {},
    {
      getJob: async () => null,
      add: async (_name: string, data: unknown) => { jobs.push(data); },
    },
  );

  await svc.enqueueTextExtraction("u", "m1", {});
  assert.equal(unsupportedIds.length, 0);
  assert.equal(jobs.length, 1);
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
  const job = thumbJobs[0] as { mediaId: string; storageKey: string; sourcePath?: string };
  assert.equal(job.mediaId, "media-1");
  assert.equal(job.storageKey, "orig/key");
  // Managed item (no sourcePath) must not carry a source path.
  assert.equal(job.sourcePath, undefined);
  assert.deepEqual(result, { ok: true });
});

test("regenerateThumbnail: in-place item carries sourcePath and allowedRoots", async () => {
  const thumbJobs: unknown[] = [];

  const svc = makeService(
    {
      findMediaKeys: async () => ({ storageKey: "external/u/m/photo.jpg", sourcePath: "C:\\nas\\photo.jpg" }),
      resetThumbState: async () => {},
    },
    {},
    {},
    { add: async (_name: string, data: unknown) => { thumbJobs.push(data); } },
  );

  await svc.regenerateThumbnail("u", "media-1", ["C:\\nas"]);
  const job = thumbJobs[0] as { sourcePath?: string; allowedRoots?: string[] };
  assert.equal(job.sourcePath, "C:\\nas\\photo.jpg");
  assert.deepEqual(job.allowedRoots, ["C:\\nas"]);
});

test("regenerateThumbnail: unsupported type enqueues no job and marks it UNSUPPORTED", async () => {
  const thumbJobs: unknown[] = [];
  let markedUnsupported: string[] | null = null;
  let thumbReset = false;

  const svc = makeService(
    {
      findMediaKeys: async () => ({ storageKey: "k", mimeType: "text/plain" }),
      resetThumbState: async () => { thumbReset = true; },
      markThumbUnsupported: async (ids: string[]) => { markedUnsupported = ids; },
    },
    {},
    {},
    { add: async (_name: string, data: unknown) => { thumbJobs.push(data); } },
  );

  const result = await svc.regenerateThumbnail("u", "media-1");
  assert.equal(thumbJobs.length, 0, "no thumb job enqueued for unsupported type");
  assert.equal(thumbReset, false, "thumb state not reset to PENDING");
  assert.deepEqual(markedUnsupported as string[] | null, ["media-1"]);
  assert.deepEqual(result, { ok: true, queued: false });
});

// ── regenerateThumbnailsBatch ─────────────────────────────────────────────────

test("regenerateThumbnailsBatch: enqueues a thumb job per found id and counts queued", async () => {
  const thumbJobs: { mediaId: string }[] = [];
  const svc = makeService(
    { findMediaKeys: async () => ({ storageKey: "k" }) },
    {},
    {},
    { add: async (_name: string, data: unknown) => { thumbJobs.push(data as { mediaId: string }); } },
  );

  const result = await svc.regenerateThumbnailsBatch("u", ["m1", "m2", "m3"]);
  assert.deepEqual(result, { queued: 3, missing: 0 });
  assert.deepEqual(thumbJobs.map(j => j.mediaId), ["m1", "m2", "m3"]);
});

test("regenerateThumbnailsBatch: counts ids the user no longer owns as missing", async () => {
  const thumbJobs: unknown[] = [];
  const svc = makeService(
    // Only m2 is found; m1/m3 return null (not owned).
    { findMediaKeys: async (_u: string, id: string) => (id === "m2" ? { storageKey: "k" } : null) },
    {},
    {},
    { add: async (_name: string, data: unknown) => { thumbJobs.push(data); } },
  );

  const result = await svc.regenerateThumbnailsBatch("u", ["m1", "m2", "m3"]);
  assert.deepEqual(result, { queued: 1, missing: 2 });
  assert.equal(thumbJobs.length, 1);
});

test("regenerateThumbnailsBatch: forwards the allowedRoots snapshot to in-place items", async () => {
  const thumbJobs: { allowedRoots?: string[] }[] = [];
  const svc = makeService(
    { findMediaKeys: async () => ({ storageKey: "external/u/m/p.jpg", sourcePath: "C:\\nas\\p.jpg" }) },
    {},
    {},
    { add: async (_name: string, data: unknown) => { thumbJobs.push(data as { allowedRoots?: string[] }); } },
  );

  await svc.regenerateThumbnailsBatch("u", ["m1"], ["C:\\nas"]);
  assert.deepEqual(thumbJobs[0].allowedRoots, ["C:\\nas"]);
});

// ── enqueueTextExtractionBatch ────────────────────────────────────────────────

test("enqueueTextExtractionBatch: enqueues an ocr job per found id and counts queued", async () => {
  const jobs: { mediaId: string; forceOcr?: boolean }[] = [];
  const svc = makeService(
    { findForTextJob: async (_u: string, id: string) => ({ id, storageKey: "k" }) },
    {},
    { getJob: async () => null, add: async (_name: string, data: unknown) => { jobs.push(data as { mediaId: string; forceOcr?: boolean }); } },
  );

  const result = await svc.enqueueTextExtractionBatch("u", ["m1", "m2"]);
  assert.deepEqual(result, { queued: 2, missing: 0 });
  assert.deepEqual(jobs.map(j => j.mediaId), ["m1", "m2"]);
  // Plain re-extract: batch never forces OCR.
  assert.equal(jobs.every(j => j.forceOcr === false), true);
});

test("enqueueTextExtractionBatch: counts not-found ids as missing", async () => {
  const jobs: unknown[] = [];
  const svc = makeService(
    { findForTextJob: async (_u: string, id: string) => (id === "m1" ? { id, storageKey: "k" } : null) },
    {},
    { getJob: async () => null, add: async (_name: string, data: unknown) => { jobs.push(data); } },
  );

  const result = await svc.enqueueTextExtractionBatch("u", ["m1", "gone"]);
  assert.deepEqual(result, { queued: 1, missing: 1 });
  assert.equal(jobs.length, 1);
});

test("enqueueTextExtractionBatch: forwards the allowedRoots snapshot to in-place items", async () => {
  const jobs: { allowedRoots?: string[] }[] = [];
  const svc = makeService(
    { findForTextJob: async () => ({ id: "m1", storageKey: "external/u/m/doc.pdf", sourcePath: "C:\\nas\\doc.pdf" }) },
    {},
    { getJob: async () => null, add: async (_name: string, data: unknown) => { jobs.push(data as { allowedRoots?: string[] }); } },
  );

  await svc.enqueueTextExtractionBatch("u", ["m1"], ["C:\\nas"]);
  assert.deepEqual(jobs[0].allowedRoots, ["C:\\nas"]);
});

// ── prioritizeThumbnail ───────────────────────────────────────────────────────

test("prioritizeThumbnail: bumps the pending job to the front via lifo", async () => {
  let opts: { lifo?: boolean; priority?: number } | undefined;
  const job = { changePriority: async (o: { lifo?: boolean }) => { opts = o; } };

  const svc = makeService({}, {}, {}, { getJob: async () => job });
  const result = await svc.prioritizeThumbnail("media-1");

  assert.deepEqual(result, { ok: true });
  // lifo (not a numeric priority): unprioritized jobs outrank prioritized ones
  // in BullMQ, so lifo keeps it unprioritized but moves it to the front.
  assert.equal(opts?.lifo, true);
  assert.equal(opts?.priority, undefined);
});

test("prioritizeThumbnail: looks up the job by mediaId", async () => {
  let requestedId: string | undefined;
  const job = { changePriority: async () => {} };

  const svc = makeService({}, {}, {}, {
    getJob: async (id: string) => { requestedId = id; return job; },
  });
  await svc.prioritizeThumbnail("media-42");

  assert.equal(requestedId, "media-42");
});

test("prioritizeThumbnail: no-op when the job is gone (completed/removed)", async () => {
  const svc = makeService({}, {}, {}, { getJob: async () => null });
  const result = await svc.prioritizeThumbnail("media-1");
  assert.deepEqual(result, { ok: false });
});

test("prioritizeThumbnail: swallows errors when the job can't be reprioritized", async () => {
  // Active jobs throw on changePriority — the caller must not see it.
  const job = { changePriority: async () => { throw new Error("job is active"); } };
  const svc = makeService({}, {}, {}, { getJob: async () => job });
  const result = await svc.prioritizeThumbnail("media-1");
  assert.deepEqual(result, { ok: false });
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

// ── unpackArchive ─────────────────────────────────────────────────────────────

/** Build a real ZIP buffer so the actual extractArchive/unzipper path runs. */
function buildZip (entries: [string, string][]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const archive = archiver("zip");
    const chunks: Buffer[] = [];
    archive.on("data", (c: Buffer) => chunks.push(c));
    archive.on("end", () => resolve(Buffer.concat(chunks)));
    archive.on("error", reject);
    for (const [name, content] of entries) archive.append(content, { name });
    void archive.finalize();
  });
}

test("unpackArchive: only enqueues thumb/OCR for compatible entries, marks the rest FAILED", async () => {
  const zip = await buildZip([
    ["photo.png", "png-bytes"],   // thumb + ocr
    ["clip.mp4", "mp4-bytes"],    // thumb only
    ["notes.txt", "text-bytes"],  // neither
  ]);

  const thumbBulks: { mediaId: string }[][] = [];
  const ocrBulks: { mediaId: string }[][] = [];
  let thumbUnsupported: string[] | null = null;
  let textUnsupported: string[] | null = null;
  // Map storageKey → assigned media id so we can resolve which file each id is.
  const idToName = new Map<string, string>();

  const svc = createMediaActionsService({
    repository: makeRepo({
      findDetail: async () => ({
        id: "arc-1", storageKey: "k/archive.zip", mimeType: "application/zip",
        title: "archive", filename: "archive.zip",
      }),
      createMedia: async (data: unknown) => {
        const d = data as { id: string; storageKey: string; filename: string };
        idToName.set(d.id, d.filename);
        return { id: d.id, storageKey: d.storageKey };
      },
      markThumbUnsupported: async (ids: string[]) => { thumbUnsupported = ids; },
      markTextUnsupported: async (ids: string[]) => { textUnsupported = ids; },
      setLinkedBundle: async () => {},
    }),
    bundleRepository: {
      createBundle: async () => ({ id: "bundle-1" }),
      addItems: async () => true,
      updateBundle: async () => {},
      setSourceMedia: async () => {},
      deleteBundle: async () => {},
    } as unknown as Parameters<typeof createMediaActionsService>[0]["bundleRepository"],
    storage: {
      // Hand the unpacker a real zip stream.
      getObjectStream: async () => ({ body: Readable.from(zip), etag: null, contentLength: null }),
      // Drain each extracted entry stream so unzipper advances to the next.
      putObject: async ({ body }: { body: Readable }) => {
        await new Promise<void>((res, rej) => {
          body.on("end", res);
          body.on("error", rej);
          body.resume();
        });
      },
    } as unknown as Parameters<typeof createMediaActionsService>[0]["storage"],
    bucket: "test-bucket",
    ocrQueue: { addBulk: async (jobs: { data: { mediaId: string } }[]) => { ocrBulks.push(jobs.map(j => j.data)); } } as unknown as Parameters<typeof createMediaActionsService>[0]["ocrQueue"],
    thumbQueue: { addBulk: async (jobs: { data: { mediaId: string } }[]) => { thumbBulks.push(jobs.map(j => j.data)); } } as unknown as Parameters<typeof createMediaActionsService>[0]["thumbQueue"],
  });

  const result = await svc.unpackArchive("u", "arc-1");
  assert.deepEqual(result, { bundleId: "bundle-1" });

  const thumbNames = (thumbBulks.flat()).map(j => idToName.get(j.mediaId)).sort();
  const ocrNames = (ocrBulks.flat()).map(j => idToName.get(j.mediaId)).sort();
  assert.deepEqual(thumbNames, ["clip.mp4", "photo.png"], "thumb only for image + video");
  assert.deepEqual(ocrNames, ["notes.txt", "photo.png"], "text extraction for image (OCR) + txt (direct read)");

  const thumbUnsupportedNames = (thumbUnsupported as string[] | null ?? []).map(id => idToName.get(id));
  const textUnsupportedNames = ((textUnsupported as string[] | null ?? []).map(id => idToName.get(id))).sort();
  assert.deepEqual(thumbUnsupportedNames, ["notes.txt"], "txt marked thumb-unsupported");
  assert.deepEqual(textUnsupportedNames, ["clip.mp4"], "only video marked text-unsupported");
});

// ── abortProcessing ───────────────────────────────────────────────────────────

type ObQueue = Parameters<typeof createMediaActionsService>[0]["ocrQueue"];

type QueueCalls = { drained: boolean; paused: boolean; resumed: boolean; cleaned: string[] };

/** A fake queue that records the abort lifecycle. `failOn` makes one step throw. */
function makeAbortQueue (
  name: string,
  log: Record<string, QueueCalls>,
  opts: { failOn?: "pause" | "drain" | "clean" } = {},
) {
  const calls: QueueCalls = { drained: false, paused: false, resumed: false, cleaned: [] };
  log[name] = calls;
  return {
    pause: async () => { if (opts.failOn === "pause") throw new Error("x"); calls.paused = true; },
    drain: async () => { if (opts.failOn === "drain") throw new Error("x"); calls.drained = true; },
    clean: async (_g: number, _l: number, type: string) => { if (opts.failOn === "clean") throw new Error("x"); calls.cleaned.push(type); },
    resume: async () => { calls.resumed = true; },
  } as unknown as ObQueue;
}

const castThumb = (q: ObQueue) => q as unknown as Parameters<typeof createMediaActionsService>[0]["thumbQueue"];
const castUnpack = (q: ObQueue) => q as unknown as Parameters<typeof createMediaActionsService>[0]["unpackQueue"];
const castIndex = (q: ObQueue) => q as unknown as Parameters<typeof createMediaActionsService>[0]["indexQueue"];

test("abortProcessing: pauses, drains, cleans, then resumes the index queue only", async () => {
  const log: Record<string, QueueCalls> = {};
  const svc = createMediaActionsService({
    repository: makeRepo(),
    bundleRepository: makeBundleRepo(),
    storage: makeS3(),
    bucket: "test-bucket",
    ocrQueue: makeAbortQueue("ocr", log),
    thumbQueue: castThumb(makeAbortQueue("thumb", log)),
    unpackQueue: castUnpack(makeAbortQueue("unpack", log)),
    indexQueue: castIndex(makeAbortQueue("index", log)),
  });

  const result = await svc.abortProcessing();
  assert.equal(result.ok, true);
  // Only the index queue (the producer) is drained — thumb/ocr jobs already
  // enqueued are left to finish so no thumbnails or text are lost mid-walk.
  assert.deepEqual(result.cleared, ["index"]);
  assert.equal(log["index"].paused, true, "index paused");
  assert.equal(log["index"].drained, true, "index drained");
  assert.deepEqual(log["index"].cleaned.sort(), ["completed", "failed"], "index cleaned terminal");
  assert.equal(log["index"].resumed, true, "index resumed");
  for (const name of ["ocr", "thumb", "unpack"]) {
    assert.equal(log[name].paused, false, `${name} untouched`);
    assert.equal(log[name].drained, false, `${name} untouched`);
  }
});

test("abortProcessing: bumps the index-abort epoch so an in-flight walk stops", async () => {
  const log: Record<string, QueueCalls> = {};
  let incrCalls = 0;
  let incrKey = "";
  const svc = createMediaActionsService({
    repository: makeRepo(),
    bundleRepository: makeBundleRepo(),
    storage: makeS3(),
    bucket: "test-bucket",
    ocrQueue: makeAbortQueue("ocr", log),
    thumbQueue: castThumb(makeAbortQueue("thumb", log)),
    indexQueue: castIndex(makeAbortQueue("index", log)),
    redis: { incr: async (key: string) => { incrCalls++; incrKey = key; return incrCalls; } },
  });

  await svc.abortProcessing();
  assert.equal(incrCalls, 1, "abort epoch incremented exactly once");
  assert.equal(incrKey, "vault:index:abort-epoch");
});

test("abortProcessing: still drains the index queue when no redis is wired (signal skipped)", async () => {
  const log: Record<string, QueueCalls> = {};
  const svc = createMediaActionsService({
    repository: makeRepo(),
    bundleRepository: makeBundleRepo(),
    storage: makeS3(),
    bucket: "test-bucket",
    ocrQueue: makeAbortQueue("ocr", log),
    thumbQueue: castThumb(makeAbortQueue("thumb", log)),
    indexQueue: castIndex(makeAbortQueue("index", log)),
    // no redis
  });

  const result = await svc.abortProcessing();
  assert.deepEqual(result.cleared, ["index"]);
});

test("abortProcessing: never obliterates (no active jobs are yanked mid-process)", async () => {
  let obliterated = false;
  const q = { pause: async () => {}, drain: async () => {}, clean: async () => {}, resume: async () => {},
    obliterate: async () => { obliterated = true; } } as unknown as ObQueue;
  const svc = createMediaActionsService({
    repository: makeRepo(), bundleRepository: makeBundleRepo(), storage: makeS3(), bucket: "b",
    ocrQueue: q, thumbQueue: castThumb(q), indexQueue: castIndex(q),
  });
  await svc.abortProcessing();
  assert.equal(obliterated, false, "must not call obliterate — that causes the Missing-key worker error");
});

test("abortProcessing: no-ops cleanly when the index queue isn't wired", async () => {
  const log: Record<string, QueueCalls> = {};
  const svc = createMediaActionsService({
    repository: makeRepo(),
    bundleRepository: makeBundleRepo(),
    storage: makeS3(),
    bucket: "test-bucket",
    ocrQueue: makeAbortQueue("ocr", log),
    thumbQueue: castThumb(makeAbortQueue("thumb", log)),
    // indexQueue intentionally omitted
  });

  const result = await svc.abortProcessing();
  assert.equal(result.ok, true);
  assert.deepEqual(result.cleared, []);
});

test("abortProcessing: a failing drain still resumes the queue (never left paused)", async () => {
  const log: Record<string, QueueCalls> = {};
  const svc = createMediaActionsService({
    repository: makeRepo(),
    bundleRepository: makeBundleRepo(),
    storage: makeS3(),
    bucket: "test-bucket",
    ocrQueue: makeAbortQueue("ocr", log),
    thumbQueue: castThumb(makeAbortQueue("thumb", log)),
    indexQueue: castIndex(makeAbortQueue("index", log, { failOn: "drain" })),
  });

  const result = await svc.abortProcessing();
  assert.equal(result.ok, true);
  // index drain threw → not reported as cleared, but it must still be resumed.
  assert.deepEqual(result.cleared, []);
  assert.equal(log["index"].resumed, true, "failing queue is resumed in finally");
});
