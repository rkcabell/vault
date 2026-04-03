import test from "node:test";
import assert from "node:assert/strict";
import { normalizeMimeType, buildMimeTypeTag } from "@/lib/tags/mimeTypeTag.js";

// ── normalizeMimeType ─────────────────────────────────────────────────────────

test("normalizeMimeType: returns known MIME type as-is", () => {
  assert.equal(normalizeMimeType("image/jpeg"), "image/jpeg");
  assert.equal(normalizeMimeType("application/pdf"), "application/pdf");
});

test("normalizeMimeType: trims whitespace from MIME type", () => {
  assert.equal(normalizeMimeType("  image/png  "), "image/png");
});

test("normalizeMimeType: null returns application/octet-stream", () => {
  assert.equal(normalizeMimeType(null), "application/octet-stream");
});

test("normalizeMimeType: undefined returns application/octet-stream", () => {
  assert.equal(normalizeMimeType(undefined), "application/octet-stream");
});

test("normalizeMimeType: octet-stream + heic filename returns image/heic", () => {
  assert.equal(normalizeMimeType("application/octet-stream", "photo.heic"), "image/heic");
});

test("normalizeMimeType: octet-stream + heif filename returns image/heif", () => {
  assert.equal(normalizeMimeType("application/octet-stream", "photo.heif"), "image/heif");
});

test("normalizeMimeType: octet-stream + unknown extension stays octet-stream", () => {
  assert.equal(normalizeMimeType("application/octet-stream", "file.xyz"), "application/octet-stream");
});

test("normalizeMimeType: octet-stream with no filename stays octet-stream", () => {
  assert.equal(normalizeMimeType("application/octet-stream"), "application/octet-stream");
});

// ── buildMimeTypeTag ──────────────────────────────────────────────────────────

test("buildMimeTypeTag: known MIME returns correct label", () => {
  assert.equal(buildMimeTypeTag("image/jpeg"), "jpg");
  assert.equal(buildMimeTypeTag("application/pdf"), "pdf");
  assert.equal(buildMimeTypeTag("video/mp4"), "mp4");
  assert.equal(buildMimeTypeTag("audio/mpeg"), "mp3");
});

test("buildMimeTypeTag: MIME takes priority over extension", () => {
  assert.equal(buildMimeTypeTag("image/jpeg", "file.png"), "jpg");
});

test("buildMimeTypeTag: octet-stream falls back to known extension label", () => {
  assert.equal(buildMimeTypeTag("application/octet-stream", "archive.zip"), "zip");
  assert.equal(buildMimeTypeTag("application/octet-stream", "doc.docx"), "docx");
});

test("buildMimeTypeTag: unknown MIME falls back to known extension label", () => {
  assert.equal(buildMimeTypeTag("application/x-unknown", "photo.jpg"), "jpg");
});

test("buildMimeTypeTag: unknown MIME falls back to raw extension", () => {
  assert.equal(buildMimeTypeTag("application/x-unknown", "file.abc"), "abc");
});

test("buildMimeTypeTag: no MIME and no filename returns unknown", () => {
  assert.equal(buildMimeTypeTag(null), "unknown");
  assert.equal(buildMimeTypeTag(undefined), "unknown");
});

test("buildMimeTypeTag: tif extension normalizes to tiff label", () => {
  assert.equal(buildMimeTypeTag(null, "scan.tif"), "tiff");
});

test("buildMimeTypeTag: jpeg extension normalizes to jpg label", () => {
  assert.equal(buildMimeTypeTag(null, "photo.jpeg"), "jpg");
});
