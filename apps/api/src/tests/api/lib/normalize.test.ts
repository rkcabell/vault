import test from "node:test";
import assert from "node:assert/strict";
import { normalizeNullable } from "@/lib/strings/normalize.js";

test("normalizeNullable: returns trimmed string", () => {
  assert.equal(normalizeNullable("hello"), "hello");
  assert.equal(normalizeNullable("  hello  "), "hello");
});

test("normalizeNullable: empty string returns null", () => {
  assert.equal(normalizeNullable(""), null);
});

test("normalizeNullable: whitespace-only string returns null", () => {
  assert.equal(normalizeNullable("   "), null);
  assert.equal(normalizeNullable("\t\n"), null);
});

test("normalizeNullable: null returns null", () => {
  assert.equal(normalizeNullable(null), null);
});

test("normalizeNullable: undefined returns null", () => {
  assert.equal(normalizeNullable(undefined), null);
});
