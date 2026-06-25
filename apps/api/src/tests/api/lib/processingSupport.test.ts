import test from "node:test";
import assert from "node:assert/strict";
import {
  ocrSupported, thumbnailSupported, exceedsThumbnailSize, MAX_THUMBNAIL_BYTES,
  isPlainTextMime, exceedsTextSize, MAX_TEXT_BYTES,
} from "@/lib/media/processingSupport.js";

// ── ocrSupported ──────────────────────────────────────────────────────────────

const OCR_SUPPORTED = [
  "image/png",
  "image/jpeg",
  "image/heic",
  "IMAGE/PNG", // case-insensitive
  "application/pdf",
  "application/x-pdf",
  "", // unknown — let the worker sniff
  // Plain text is extracted via a direct read (no OCR).
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/html",
  "TEXT/PLAIN", // case-insensitive
];

const OCR_UNSUPPORTED = [
  "video/mp4",
  "application/json",
  "application/zip",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/octet-stream",
];

for (const mime of OCR_SUPPORTED) {
  test(`ocrSupported: "${mime}" is supported`, () => {
    assert.equal(ocrSupported(mime), true);
  });
}

for (const mime of OCR_UNSUPPORTED) {
  test(`ocrSupported: "${mime}" is not supported`, () => {
    assert.equal(ocrSupported(mime), false);
  });
}

// ── thumbnailSupported ──────────────────────────────────────────────────────────

const THUMB_SUPPORTED = [
  "image/png",
  "image/jpeg",
  "image/heic",
  "image/heif",
  "IMAGE/WEBP", // case-insensitive
  "video/mp4",
  "video/quicktime",
  "application/pdf",
  "", // unknown — let the worker sniff
];

const THUMB_UNSUPPORTED = [
  "text/plain",
  "application/json",
  "application/zip",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/octet-stream",
];

for (const mime of THUMB_SUPPORTED) {
  test(`thumbnailSupported: "${mime}" is supported`, () => {
    assert.equal(thumbnailSupported(mime), true);
  });
}

for (const mime of THUMB_UNSUPPORTED) {
  test(`thumbnailSupported: "${mime}" is not supported`, () => {
    assert.equal(thumbnailSupported(mime), false);
  });
}

// ── exceedsThumbnailSize ────────────────────────────────────────────────────────

test("exceedsThumbnailSize: false for unknown/missing size (let the worker try)", () => {
  assert.equal(exceedsThumbnailSize(undefined), false);
  assert.equal(exceedsThumbnailSize(null), false);
});

test("exceedsThumbnailSize: false at or below the 2 GiB limit", () => {
  assert.equal(exceedsThumbnailSize(0), false);
  assert.equal(exceedsThumbnailSize(500 * 1024 * 1024), false);
  assert.equal(exceedsThumbnailSize(MAX_THUMBNAIL_BYTES), false); // exactly at limit is allowed
});

test("exceedsThumbnailSize: true above the limit", () => {
  assert.equal(exceedsThumbnailSize(MAX_THUMBNAIL_BYTES + 1), true);
  assert.equal(exceedsThumbnailSize(5 * 1024 * 1024 * 1024), true);
});

// ── isPlainTextMime / exceedsTextSize ───────────────────────────────────────────

test("isPlainTextMime matches text/* only", () => {
  for (const m of ["text/plain", "text/markdown", "text/csv", "text/html", "TEXT/PLAIN"]) {
    assert.equal(isPlainTextMime(m), true, m);
  }
  for (const m of ["application/json", "application/pdf", "image/png", ""]) {
    assert.equal(isPlainTextMime(m), false, m);
  }
});

test("exceedsTextSize: false for unknown/missing and at/under the limit", () => {
  assert.equal(exceedsTextSize(undefined), false);
  assert.equal(exceedsTextSize(null), false);
  assert.equal(exceedsTextSize(0), false);
  assert.equal(exceedsTextSize(MAX_TEXT_BYTES), false); // exactly at limit allowed
});

test("exceedsTextSize: true above the limit", () => {
  assert.equal(exceedsTextSize(MAX_TEXT_BYTES + 1), true);
});
