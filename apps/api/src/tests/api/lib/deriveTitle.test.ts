import test from "node:test";
import assert from "node:assert/strict";
import { deriveTitle } from "@/lib/media/deriveTitle.js";

test("deriveTitle: returns explicit title trimmed", () => {
  assert.equal(deriveTitle("file.pdf", "My Document"), "My Document");
  assert.equal(deriveTitle("file.pdf", "  My Document  "), "My Document");
});

test("deriveTitle: blank title falls back to filename", () => {
  assert.equal(deriveTitle("file.pdf", ""), "file");
  assert.equal(deriveTitle("file.pdf", "   "), "file");
});

test("deriveTitle: null title falls back to filename", () => {
  assert.equal(deriveTitle("file.pdf", null), "file");
});

test("deriveTitle: strips extension from filename", () => {
  assert.equal(deriveTitle("my-document.pdf"), "my-document");
  assert.equal(deriveTitle("photo.jpeg"), "photo");
  assert.equal(deriveTitle("archive.tar.gz"), "archive.tar");
});

test("deriveTitle: filename with no extension returned as-is", () => {
  assert.equal(deriveTitle("README"), "README");
});

test("deriveTitle: dotfile returns full filename", () => {
  assert.equal(deriveTitle(".bashrc"), ".bashrc");
});

test("deriveTitle: empty filename with no title returns Untitled", () => {
  assert.equal(deriveTitle(""), "Untitled");
});

test("deriveTitle: whitespace-only filename returns Untitled", () => {
  assert.equal(deriveTitle("   "), "Untitled");
});
