import test from "node:test";
import assert from "node:assert/strict";
import { normalizeExtensions } from "@/lib/media/extensions.js";

test("normalizeExtensions: lowercases, strips leading dots, trims", () => {
  assert.deepEqual(normalizeExtensions([".TMP", "  Log ", "..ISO"]), ["tmp", "log", "iso"]);
});

test("normalizeExtensions: drops blanks and dedupes (order preserved)", () => {
  assert.deepEqual(normalizeExtensions(["tmp", "", "  ", ".tmp", "TMP", "log"]), ["tmp", "log"]);
});

test("normalizeExtensions: handles undefined / empty", () => {
  assert.deepEqual(normalizeExtensions(undefined), []);
  assert.deepEqual(normalizeExtensions([]), []);
});
