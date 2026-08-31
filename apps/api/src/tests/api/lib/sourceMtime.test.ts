import test from "node:test";
import assert from "node:assert/strict";
import { sameMtime } from "@/lib/media/sourceMtime.js";

test("an unknown mtime never matches", () => {
  assert.equal(sameMtime(null, 1000), false);
  assert.equal(sameMtime(1000, null), false);
  assert.equal(sameMtime(null, null), false);
});

test("identical mtimes match", () => {
  assert.equal(sameMtime(1785539218283.6233, 1785539218283.6233), true);
});

test("the digit Prisma drops when storing a Float does not count as a change", () => {
  // Measured against Postgres: writing this value back reads as ...283.623.
  assert.equal(sameMtime(1785539218283.623, 1785539218283.6233), true);
  // Rounding up across the integer boundary is the same loss in the other
  // direction, and a truncating comparison would miss it.
  assert.equal(sameMtime(1785539218284, 1785539218283.9998), true);
});

test("a real edit still registers", () => {
  assert.equal(sameMtime(1785539218283.6233, 1785539218284.6233), false);
  assert.equal(sameMtime(1000, 2000), false);
});

test("the tolerance is exclusive, so a full millisecond is a change", () => {
  assert.equal(sameMtime(1000, 1001), false);
  assert.equal(sameMtime(1000, 1000.999), true);
});
