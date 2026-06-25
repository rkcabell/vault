import test from "node:test";
import assert from "node:assert/strict";
import { mimeFromExtension } from "@/lib/media/mimeFromExtension.js";

test("maps common image/document/video extensions", () => {
  assert.equal(mimeFromExtension("photo.JPG"), "image/jpeg");
  assert.equal(mimeFromExtension("scan.pdf"), "application/pdf");
  assert.equal(mimeFromExtension("clip.mp4"), "video/mp4");
  assert.equal(mimeFromExtension("notes.txt"), "text/plain");
  assert.equal(mimeFromExtension("sheet.xlsx"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
});

test("is case-insensitive and handles multi-dot names", () => {
  assert.equal(mimeFromExtension("My.Vacation.HEIC"), "image/heic");
  assert.equal(mimeFromExtension("archive.tar.gz"), "application/gzip");
});

test("falls back to octet-stream for unknown or extension-less names", () => {
  assert.equal(mimeFromExtension("README"), "application/octet-stream");
  assert.equal(mimeFromExtension("data.unknownext"), "application/octet-stream");
});
