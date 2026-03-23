import test from "node:test";
import assert from "node:assert/strict";
import { createMediaReadService } from "@/services/media/mediaReadService.js";

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Parameters<typeof createMediaReadService>[0]["logger"];

// ── mock builders ─────────────────────────────────────────────────────────────

function makeRepo (overrides: {
  findDocumentForUser?: (_userId: string, _id: string) => Promise<unknown>;
  findDetail?: (_userId: string, _id: string) => Promise<unknown>;
} = {}) {
  return {
    findDocumentForUser: overrides.findDocumentForUser ?? (async () => null),
    findDetail: overrides.findDetail ?? (async () => null),
  } as unknown as Parameters<typeof createMediaReadService>[0]["repository"];
}

function makeS3 (overrides: {
  getObjectStream?: (_args: unknown) => Promise<unknown>;
} = {}) {
  return {
    getObjectStream: overrides.getObjectStream ?? (async () => null),
  } as unknown as Parameters<typeof createMediaReadService>[0]["s3Adapter"];
}

function makeService (repoOverrides = {}, s3Overrides = {}) {
  return createMediaReadService({
    repository: makeRepo(repoOverrides),
    s3Adapter: makeS3(s3Overrides),
    bucket: "test-bucket",
    logger,
  });
}

// ── getTextChunk ──────────────────────────────────────────────────────────────

test("getTextChunk: returns null when media not found", async () => {
  const svc = makeService();
  const result = await svc.getTextChunk("u", "m", 0, 100);
  assert.equal(result, null);
});

test("getTextChunk: returns the requested slice of rawText", async () => {
  const raw = "Hello, world! This is a longer document.";
  const svc = makeService({
    findDocumentForUser: async () => ({
      document: { rawText: raw, textSource: "NATIVE" },
      mimeType: "application/pdf",
    }),
  });

  const result = await svc.getTextChunk("u", "m", 0, 5);
  assert.equal(result?.text, "Hello");
  assert.equal(result?.offset, 0);
  assert.equal(result?.limit, 5);
  assert.equal(result?.totalLength, raw.length);
  assert.equal(result?.hasMore, true);
});

test("getTextChunk: hasMore is false when slice reaches the end", async () => {
  const raw = "Short text";
  const svc = makeService({
    findDocumentForUser: async () => ({
      document: { rawText: raw, textSource: "NATIVE" },
      mimeType: "text/plain",
    }),
  });

  const result = await svc.getTextChunk("u", "m", 0, 1000);
  assert.equal(result?.text, raw);
  assert.equal(result?.hasMore, false);
});

test("getTextChunk: mid-document offset returns correct slice and hasMore", async () => {
  const raw = "ABCDEFGHIJ"; // 10 chars
  const svc = makeService({
    findDocumentForUser: async () => ({
      document: { rawText: raw, textSource: "OCR" },
      mimeType: "image/png",
    }),
  });

  const result = await svc.getTextChunk("u", "m", 5, 3);
  assert.equal(result?.text, "FGH");
  assert.equal(result?.offset, 5);
  assert.equal(result?.hasMore, true); // "IJ" remains
});

test("getTextChunk: empty document returns empty text with hasMore false", async () => {
  const svc = makeService({
    findDocumentForUser: async () => ({
      document: { rawText: "", textSource: null },
      mimeType: "text/plain",
    }),
  });

  const result = await svc.getTextChunk("u", "m", 0, 100);
  assert.equal(result?.text, "");
  assert.equal(result?.hasMore, false);
  assert.equal(result?.totalLength, 0);
});

test("getTextChunk: media with no document returns empty text", async () => {
  const svc = makeService({
    findDocumentForUser: async () => ({
      document: null,
      mimeType: "image/png",
    }),
  });

  const result = await svc.getTextChunk("u", "m", 0, 100);
  assert.equal(result?.text, "");
  assert.equal(result?.totalLength, 0);
});

// ── getMediaDetail ────────────────────────────────────────────────────────────

test("getMediaDetail: returns null when media not found", async () => {
  const svc = makeService();
  const result = await svc.getMediaDetail("u", "m");
  assert.equal(result, null);
});

test("getMediaDetail: document is null when media has no document", async () => {
  const svc = makeService({
    findDetail: async () => ({
      id: "m1", mimeType: "image/jpeg", textState: "PENDING",
      thumbnailKey: null, document: null, extractedMetadata: null, bundleItems: [],
    }),
  });

  const result = await svc.getMediaDetail("u", "m1");
  assert.equal(result?.document, null);
  assert.equal(result?.media.hasText, false);
  assert.equal(result?.media.hasThumb, false);
});

test("getMediaDetail: hasThumb is true when thumbnailKey is set", async () => {
  const svc = makeService({
    findDetail: async () => ({
      id: "m1", mimeType: "image/jpeg", textState: "READY",
      thumbnailKey: "thumbs/m1.webp", document: null, extractedMetadata: null, bundleItems: [],
    }),
  });

  const result = await svc.getMediaDetail("u", "m1");
  assert.equal(result?.media.hasThumb, true);
});

test("getMediaDetail: hasText is true when document has text", async () => {
  const svc = makeService({
    findDetail: async () => ({
      id: "m1", mimeType: "text/plain", textState: "READY",
      thumbnailKey: null,
      document: { rawText: "Some document content", textSource: "NATIVE", pages: null },
      extractedMetadata: null, bundleItems: [],
    }),
  });

  const result = await svc.getMediaDetail("u", "m1");
  assert.equal(result?.media.hasText, true);
  assert.ok((result?.document?.textTotalLength ?? 0) > 0);
});

test("getMediaDetail: permissions are always fully granted", async () => {
  const svc = makeService({
    findDetail: async () => ({
      id: "m1", mimeType: "image/jpeg", textState: "PENDING",
      thumbnailKey: null, document: null, extractedMetadata: null, bundleItems: [],
    }),
  });

  const result = await svc.getMediaDetail("u", "m1");
  assert.deepEqual(result?.permissions, {
    canEdit: true, canDelete: true, canDownload: true, canOcr: true,
  });
});

test("getMediaDetail: segments document text using pages when available", async () => {
  const pages = [
    { pageNumber: 1, text: "Page one content", numChars: 16 },
    { pageNumber: 2, text: "Page two content", numChars: 16 },
  ];
  const svc = makeService({
    findDetail: async () => ({
      id: "m1", mimeType: "application/pdf", textState: "READY",
      thumbnailKey: null,
      document: { rawText: "Page one content\n\nPage two content", textSource: "NATIVE", pages },
      extractedMetadata: null, bundleItems: [],
    }),
  });

  const result = await svc.getMediaDetail("u", "m1");
  // One segment per page
  assert.equal(result?.document?.segments.length, 2);
});

test("getMediaDetail: passes through jobMeta fields as null when no ocrQueue", async () => {
  const svc = makeService({
    findDetail: async () => ({
      id: "m1", mimeType: "image/jpeg", textState: "ERROR",
      thumbnailKey: null, document: null, extractedMetadata: null, bundleItems: [],
    }),
  });

  const result = await svc.getMediaDetail("u", "m1");
  // No ocrQueue provided → jobMeta is null → these fields default to null
  assert.equal(result?.media.textError, null);
  assert.equal(result?.media.textAttemptsMade, null);
  assert.equal(result?.media.textAttemptsTotal, null);
});

// ── getThumbnail ──────────────────────────────────────────────────────────────

test("getThumbnail: returns null when S3 returns nothing", async () => {
  const svc = makeService({}, { getObjectStream: async () => null });
  const result = await svc.getThumbnail("m1");
  assert.equal(result, null);
});

test("getThumbnail: returns body and etag from S3", async () => {
  const fakeBody = { pipe: () => {} };
  const svc = makeService({}, {
    getObjectStream: async () => ({ body: fakeBody, etag: '"abc123"' }),
  });

  const result = await svc.getThumbnail("m1");
  assert.equal(result?.body, fakeBody);
  assert.equal(result?.etag, '"abc123"');
});

test("getThumbnail: returns null and does not throw when S3 throws", async () => {
  const svc = makeService({}, {
    getObjectStream: async () => { throw new Error("S3 error"); },
  });

  const result = await svc.getThumbnail("m1");
  assert.equal(result, null);
});
