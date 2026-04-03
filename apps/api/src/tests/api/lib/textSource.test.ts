import test from "node:test";
import assert from "node:assert/strict";
import { inferTextSource } from "@/lib/media/textSource.js";

test("inferTextSource: documentTextSource OCR returns OCR", () => {
  assert.equal(inferTextSource({ documentTextSource: "OCR" }), "OCR");
});

test("inferTextSource: documentTextSource NATIVE returns NATIVE", () => {
  assert.equal(inferTextSource({ documentTextSource: "NATIVE" }), "NATIVE");
});

test("inferTextSource: null documentTextSource + text/ MIME returns NATIVE", () => {
  assert.equal(inferTextSource({ documentTextSource: null, mimeType: "text/plain" }), "NATIVE");
  assert.equal(inferTextSource({ documentTextSource: null, mimeType: "text/csv" }), "NATIVE");
  assert.equal(inferTextSource({ documentTextSource: null, mimeType: "text/html" }), "NATIVE");
});

test("inferTextSource: null documentTextSource + non-text MIME returns UNKNOWN", () => {
  assert.equal(inferTextSource({ documentTextSource: null, mimeType: "image/jpeg" }), "UNKNOWN");
  assert.equal(inferTextSource({ documentTextSource: null, mimeType: "application/pdf" }), "UNKNOWN");
});

test("inferTextSource: undefined inputs return UNKNOWN", () => {
  assert.equal(inferTextSource({ documentTextSource: undefined, mimeType: undefined }), "UNKNOWN");
  assert.equal(inferTextSource({}), "UNKNOWN");
});

test("inferTextSource: unrecognized documentTextSource defers to mimeType", () => {
  assert.equal(inferTextSource({ documentTextSource: "OTHER", mimeType: "text/plain" }), "NATIVE");
  assert.equal(inferTextSource({ documentTextSource: "OTHER", mimeType: "image/png" }), "UNKNOWN");
});
