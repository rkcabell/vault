import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { createMediaActionsService } from "@/services/media/mediaActionsService.js";

// ── mock builders ─────────────────────────────────────────────────────────────

type MediaKeys = { storageKey: string; thumbnailKey?: string | null; sourcePath?: string | null; mimeType?: string | null };
type TextJobMedia = { id: string; storageKey: string; title?: string | null; sourcePath?: string | null; mimeType?: string | null };

function makeRepo (overrides: {
  findMediaKeys?: (_userId: string, _id: string) => Promise<MediaKeys | null>;
  deleteMedia?: (_id: string) => Promise<void>;
  findMediaForUpdate?: (_userId: string, _id: string) => Promise<{ id: string } | null>;
  updateMetadata?: (_id: string, _data: unknown) => Promise<unknown>;
  findForTextJob?: (_userId: string, _id: string) => Promise<TextJobMedia | null>;
  setTextStatePending?: (_id: string) => Promise<boolean>;
  setTextState?: (_id: string, _state: string) => Promise<void>;
  findStorageKey?: (_userId: string, _id: string) => Promise<{ storageKey: string } | null>;
  resetThumbState?: (_id: string) => Promise<void>;
  markThumbUnsupported?: (_ids: string[]) => Promise<void>;
  markTextUnsupported?: (_ids: string[]) => Promise<void>;
  claimNeedsOcrBatch?: (_userId: string, _limit: number) => Promise<
    { id: string; storageKey: string; sourcePath: string | null; title: string }[]
  >;
  countNeedsOcr?: (_userId: string) => Promise<number>;
} = {}) {
  // `Media.mimeType` is non-nullable and both selects include it, so a row
  // without one is not a state the service can be handed. Fixtures that don't
  // care which type it is get a renderable, extractable default rather than
  // exercising the unreachable empty-mime branch.
  const withMime = <T extends { mimeType?: string | null }>(
    fn: ((_userId: string, _id: string) => Promise<T | null>) | undefined,
    fallback: () => Promise<T | null>,
  ) => async (userId: string, id: string) => {
    const row = await (fn ?? fallback)(userId, id);
    return row && !row.mimeType ? { ...row, mimeType: "application/pdf" } : row;
  };

  return {
    findMediaKeys: withMime(overrides.findMediaKeys, async () => null),
    deleteMedia: overrides.deleteMedia ?? (async () => {}),
    findMediaForUpdate: overrides.findMediaForUpdate ?? (async () => null),
    updateMetadata: overrides.updateMetadata ?? (async () => ({})),
    findForTextJob: withMime(overrides.findForTextJob, async () => null),
    setTextStatePending: overrides.setTextStatePending ?? (async () => true),
    setTextState: overrides.setTextState ?? (async () => {}),
    findStorageKey: overrides.findStorageKey ?? (async () => null),
    resetThumbState: overrides.resetThumbState ?? (async () => {}),
    markThumbUnsupported: overrides.markThumbUnsupported ?? (async () => {}),
    markTextUnsupported: overrides.markTextUnsupported ?? (async () => {}),
    claimNeedsOcrBatch: overrides.claimNeedsOcrBatch ?? (async () => []),
    countNeedsOcr: overrides.countNeedsOcr ?? (async () => 0),
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

function makeService (repoOverrides = {}, s3Overrides = {}, textQueueOverrides = {}, thumbQueueOverrides = {}) {
  // One mock stands in for both text tiers: these tests observe *that* a job was
  // enqueued and *that* a stale one was cleared, not which of the two queues took
  // it. Which tier a job routes to is asserted separately, below.
  const q = makeQueue(textQueueOverrides);
  return createMediaActionsService({
    repository: makeRepo(repoOverrides),
    bundleRepository: makeBundleRepo(),
    storage: makeS3(s3Overrides),
    bucket: "test-bucket",
    textQueue: q,
    ocrQueue: q,
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
      setTextStatePending: async () => { pendingSet = true; return true; },
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

test("enqueueTextExtraction: returns { ok: true, queued: true } on success", async () => {
  const svc = makeService(
    { findForTextJob: async () => ({ id: "m1", storageKey: "k" }) },
    {},
    { getJob: async () => null, add: async () => {} },
  );
  const result = await svc.enqueueTextExtraction("u", "m1", {});
  assert.deepEqual(result, { ok: true, queued: true });
});

// setTextStatePending is guarded on PENDING/READY/ERROR/NEEDS_OCR, so it refuses
// an UNSUPPORTED row — which a text/* file over MAX_TEXT_BYTES reaches via the
// worker despite clearing ocrSupported. Enqueueing past the refusal produced a
// job the worker discarded unrun, under a UI that said the run had started.
test("enqueueTextExtraction: a refused state transition enqueues nothing", async () => {
  const jobs: unknown[] = [];
  const svc = makeService(
    {
      findForTextJob: async () => ({ id: "m1", storageKey: "k", mimeType: "text/plain" }),
      setTextStatePending: async () => false,
    },
    {},
    {
      getJob: async () => null,
      add: async (_name: string, data: unknown) => { jobs.push(data); },
    },
  );

  const result = await svc.enqueueTextExtraction("u", "m1", {});
  assert.deepEqual(result, { ok: true, queued: false });
  assert.equal(jobs.length, 0);
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
  assert.deepEqual(result, { ok: true, queued: false });
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
      setTextStatePending: async () => true,
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

// ── enqueueTextExtraction: which tier gets the job ─────────────────────

/** Wire the two tiers to separate spies so routing is observable. */
function makeRoutedService (repoOverrides = {}) {
  const textAdds: { data: unknown; opts: unknown }[] = [];
  const ocrAdds: { data: unknown; opts: unknown }[] = [];
  const gotJob: string[] = [];
  const svc = createMediaActionsService({
    repository: makeRepo(repoOverrides),
    bundleRepository: makeBundleRepo(),
    storage: makeS3(),
    bucket: "test-bucket",
    textQueue: makeQueue({
      getJob: async (id: string) => { gotJob.push(`text:${id}`); return null; },
      add: async (_n: string, data: unknown, opts?: unknown) => { textAdds.push({ data, opts }); },
    }),
    ocrQueue: makeQueue({
      getJob: async (id: string) => { gotJob.push(`ocr:${id}`); return null; },
      add: async (_n: string, data: unknown, opts?: unknown) => { ocrAdds.push({ data, opts }); },
    }),
    thumbQueue: makeThumbQueue(),
  });
  return { svc, textAdds, ocrAdds, gotJob };
}

test("enqueueTextExtraction: an unforced job goes to the text queue, not the OCR queue", async () => {
  const { svc, textAdds, ocrAdds } = makeRoutedService({
    findForTextJob: async () => ({ id: "m1", storageKey: "k", mimeType: "application/pdf", textState: "PENDING" }),
  });

  await svc.enqueueTextExtraction("u", "m1", {});

  assert.equal(textAdds.length, 1, "native extraction belongs on the cheap queue");
  assert.equal(ocrAdds.length, 0);
  assert.equal((textAdds[0].data as { forceOcr?: boolean }).forceOcr, false);
});

test("enqueueTextExtraction: forceOcr sends the job to the OCR queue", async () => {
  const { svc, textAdds, ocrAdds } = makeRoutedService({
    findForTextJob: async () => ({ id: "m1", storageKey: "k", mimeType: "application/pdf", textState: "PENDING" }),
  });

  await svc.enqueueTextExtraction("u", "m1", { forceOcr: true });

  assert.equal(ocrAdds.length, 1, "Tesseract work must not land on the text pool");
  assert.equal(textAdds.length, 0);
  assert.equal((ocrAdds[0].data as { forceOcr?: boolean }).forceOcr, true);
});

test("enqueueTextExtraction: a NEEDS_OCR row routes to the OCR queue without an explicit force", async () => {
  // The row has already had its native pass and come up empty, so "extract text"
  // can only mean tier 2 — and tier 2 only ever runs off ocr_queue.
  const { svc, textAdds, ocrAdds } = makeRoutedService({
    findForTextJob: async () => ({ id: "m1", storageKey: "k", mimeType: "application/pdf", textState: "NEEDS_OCR" }),
  });

  await svc.enqueueTextExtraction("u", "m1", {});

  assert.equal(ocrAdds.length, 1);
  assert.equal(textAdds.length, 0);
});

test("enqueueTextExtraction: clears the stale job from both tiers before re-queueing", async () => {
  // BullMQ silently drops an add when the id already exists, and the same id is
  // used in both key spaces — clearing only one queue leaves a re-extraction that
  // sometimes does nothing at all.
  const { svc, gotJob } = makeRoutedService({
    findForTextJob: async () => ({ id: "m1", storageKey: "k", mimeType: "application/pdf", textState: "PENDING" }),
  });

  await svc.enqueueTextExtraction("u", "m1", {});

  assert.deepEqual(gotJob.sort(), ["ocr:ocr-m1", "text:ocr-m1"]);
});

test("enqueueTextExtraction: user-initiated work outranks the background sweep", async () => {
  const { svc, ocrAdds } = makeRoutedService({
    findForTextJob: async () => ({ id: "m1", storageKey: "k", mimeType: "application/pdf", textState: "NEEDS_OCR" }),
  });

  await svc.enqueueTextExtraction("u", "m1", {});

  const opts = ocrAdds[0].opts as { priority?: number };
  assert.equal(opts.priority, 1, "background NEEDS_OCR sweeps enqueue at 20; the user jumps them");
});

test("cancelTextExtraction: removes the job from both tiers", async () => {
  const removed: string[] = [];
  const svc = createMediaActionsService({
    repository: makeRepo({ findForTextJob: async () => ({ id: "m1", storageKey: "k" }) }),
    bundleRepository: makeBundleRepo(),
    storage: makeS3(),
    bucket: "test-bucket",
    textQueue: makeQueue({ getJob: async () => ({ remove: async () => { removed.push("text"); } }) }),
    ocrQueue: makeQueue({ getJob: async () => ({ remove: async () => { removed.push("ocr"); } }) }),
    thumbQueue: makeThumbQueue(),
  });

  await svc.cancelTextExtraction("u", "m1");

  assert.deepEqual(removed.sort(), ["ocr", "text"]);
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

// ── extractAllScannedText ─────────────────────────────────────────────────────

/** A repo whose NEEDS_OCR backlog is `total` rows, claimed in bounded batches. */
function makeBacklogRepo (total: number, extra: Record<string, unknown> = {}) {
  let remaining = total;
  let next = 0;
  const claims: number[] = [];
  const repo = makeRepo({
    claimNeedsOcrBatch: async (_userId: string, limit: number) => {
      claims.push(limit);
      const take = Math.min(limit, remaining);
      remaining -= take;
      return Array.from({ length: take }, () => {
        const n = next++;
        return { id: `m${n}`, storageKey: `k${n}`, sourcePath: null, title: `Scan ${n}` };
      });
    },
    countNeedsOcr: async () => remaining,
    ...extra,
  });
  return { repo, claims };
}

function makeBacklogService (total: number, extra: Record<string, unknown> = {}) {
  const bulks: { data: { mediaId: string; forceOcr?: boolean }; opts: { priority?: number } }[][] = [];
  const { repo, claims } = makeBacklogRepo(total, extra);
  const svc = createMediaActionsService({
    repository: repo,
    bundleRepository: makeBundleRepo(),
    storage: makeS3(),
    bucket: "test-bucket",
    textQueue: makeQueue(),
    ocrQueue: {
      getJob: async () => null,
      addBulk: async (jobs: { data: { mediaId: string; forceOcr?: boolean }; opts: { priority?: number } }[]) => { bulks.push(jobs); },
    } as unknown as Parameters<typeof createMediaActionsService>[0]["ocrQueue"],
    thumbQueue: makeThumbQueue(),
  });
  return { svc, bulks, claims };
}

test("extractAllScannedText: queues the whole backlog as forced tier-2 work", async () => {
  const { svc, bulks } = makeBacklogService(3);

  const result = await svc.extractAllScannedText("u");

  assert.deepEqual(result, { queued: 3, remaining: 0 });
  const jobs = bulks.flat();
  assert.equal(jobs.length, 3);
  // Every one of these rows already had native extraction run and come up empty,
  // so anything but forceOcr would redo the native pass and re-park them.
  assert.ok(jobs.every(j => j.data.forceOcr === true), "all jobs force tier 2");
  assert.ok(jobs.every(j => j.opts.priority === 1), "user work outranks the background sweep");
});

test("extractAllScannedText: no backlog is a clean no-op", async () => {
  const { svc, bulks } = makeBacklogService(0);

  const result = await svc.extractAllScannedText("u");

  assert.deepEqual(result, { queued: 0, remaining: 0 });
  assert.equal(bulks.length, 0, "an empty claim must not open a queue round-trip");
});

test("extractAllScannedText: claims in chunks rather than one unbounded query", async () => {
  const { svc, claims } = makeBacklogService(600);

  const result = await svc.extractAllScannedText("u");

  assert.equal(result.queued, 600);
  assert.ok(claims.length > 1, "the backlog is drained in batches");
  assert.ok(claims.every(c => c <= 250), `each claim is bounded, got ${claims.join(",")}`);
});

test("extractAllScannedText: honours the caller's limit and reports what is left", async () => {
  // Each job is minutes of a core, so one press must not commit the box to a
  // month of OCR — it queues a slice and hands back the rest.
  const { svc, bulks } = makeBacklogService(1000);

  const result = await svc.extractAllScannedText("u", [], 400);

  assert.equal(result.queued, 400);
  assert.equal(result.remaining, 600);
  assert.equal(bulks.flat().length, 400);
});

test("extractAllScannedText: in-place rows carry the allow-list snapshot", async () => {
  const bulks: { data: { sourcePath?: string; allowedRoots?: string[] } }[][] = [];
  const svc = createMediaActionsService({
    repository: makeRepo({
      claimNeedsOcrBatch: async () => [
        { id: "m1", storageKey: "external/u/m1/scan.pdf", sourcePath: "/nas/scan.pdf", title: "Scan" },
        { id: "m2", storageKey: "managed/k", sourcePath: null, title: "Upload" },
      ],
      countNeedsOcr: async () => 0,
    }),
    bundleRepository: makeBundleRepo(),
    storage: makeS3(),
    bucket: "test-bucket",
    textQueue: makeQueue(),
    ocrQueue: {
      getJob: async () => null,
      addBulk: async (jobs: { data: { sourcePath?: string; allowedRoots?: string[] } }[]) => { bulks.push(jobs); },
    } as unknown as Parameters<typeof createMediaActionsService>[0]["ocrQueue"],
    thumbQueue: makeThumbQueue(),
  });

  await svc.extractAllScannedText("u", ["/nas"]);

  const [inPlace, managed] = bulks.flat();
  // Without the snapshot the worker re-validates the path against an empty
  // allow-list and the source read is rejected.
  assert.equal(inPlace.data.sourcePath, "/nas/scan.pdf");
  assert.deepEqual(inPlace.data.allowedRoots, ["/nas"]);
  assert.equal(managed.data.sourcePath, undefined, "managed rows read from storage, not disk");
  assert.equal(managed.data.allowedRoots, undefined);
});

test("extractAllScannedText: clears stale jobs on both tiers before re-queueing", async () => {
  const removed: string[] = [];
  const svc = createMediaActionsService({
    repository: makeRepo({
      claimNeedsOcrBatch: async () =>
        removed.length === 0
          ? [{ id: "m1", storageKey: "k", sourcePath: null, title: "Scan" }]
          : [],
      countNeedsOcr: async () => 0,
    }),
    bundleRepository: makeBundleRepo(),
    storage: makeS3(),
    bucket: "test-bucket",
    textQueue: makeQueue({ getJob: async () => ({ remove: async () => { removed.push("text"); } }) }),
    ocrQueue: {
      getJob: async () => ({ remove: async () => { removed.push("ocr"); } }),
      addBulk: async () => {},
    } as unknown as Parameters<typeof createMediaActionsService>[0]["ocrQueue"],
    thumbQueue: makeThumbQueue(),
  });

  await svc.extractAllScannedText("u");

  // A background-sweep job still waiting under this id would otherwise make the
  // bulk add a silent no-op for that row.
  assert.deepEqual(removed.sort(), ["ocr", "text"]);
});
