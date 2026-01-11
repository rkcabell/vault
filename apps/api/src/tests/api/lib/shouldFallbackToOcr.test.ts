//File: apps/api/src/tests/api/lib/shouldFallbackToOcr.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import {
  MIN_TEXT_PAGE_RATIO,
  MIN_TOTAL_CHARS,
  shouldFallbackToOcr,
} from "../../../lib/pdf/shouldFallbackToOcr.js";

test("shouldFallbackToOcr flags low total text", () => {
  const needsOcr = shouldFallbackToOcr({
    totalChars: MIN_TOTAL_CHARS - 1,
    pagesWithText: 10,
    numPages: 10,
  });
  assert.equal(needsOcr, true);
});

test("shouldFallbackToOcr flags too few text pages", () => {
  const minPages = Math.max(1, Math.ceil(10 * MIN_TEXT_PAGE_RATIO));
  const needsOcr = shouldFallbackToOcr({
    totalChars: MIN_TOTAL_CHARS + 100,
    pagesWithText: minPages - 1,
    numPages: 10,
  });
  assert.equal(needsOcr, true);
});

test("shouldFallbackToOcr allows sufficient text", () => {
  const minPages = Math.max(1, Math.ceil(5 * MIN_TEXT_PAGE_RATIO));
  const needsOcr = shouldFallbackToOcr({
    totalChars: MIN_TOTAL_CHARS + 50,
    pagesWithText: minPages,
    numPages: 5,
  });
  assert.equal(needsOcr, false);
});
