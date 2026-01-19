import test from "node:test";
import assert from "node:assert/strict";
import { normalizeTags, TagValidationError } from "@/lib/tags/normalizeTags.js";

const expectTagError = (fn: () => unknown, code: TagValidationError["code"]) => {
  assert.throws(
    fn,
    (error: unknown) => error instanceof TagValidationError && error.code === code,
  );
};

test("normalizes whitespace, underscores, and casing", () => {
  assert.deepEqual(normalizeTags(" Car Insurance "), ["car-insurance"]);
  assert.deepEqual(normalizeTags(["car--insurance", "car_insurance"]), ["car-insurance"]);
});

test("splits comma-separated strings and dedupes", () => {
  assert.deepEqual(normalizeTags("alpha, beta,ALPHA"), ["alpha", "beta"]);
});

test("is idempotent", () => {
  const once = normalizeTags(["Car Insurance", "beta_test"]);
  assert.deepEqual(normalizeTags(once), once);
});

test("rejects empty or blank tags", () => {
  expectTagError(() => normalizeTags(["", "   "]), "EMPTY");
});

test("rejects tags that exceed max length", () => {
  const tooLong = "a".repeat(49);
  expectTagError(() => normalizeTags([tooLong]), "TOO_LONG");
});

test("rejects tags with invalid characters", () => {
  expectTagError(() => normalizeTags(["car$insurance"]), "INVALID_CHARS");
});

test("rejects reserved underscore prefix", () => {
  expectTagError(() => normalizeTags(["_hidden"]), "RESERVED_PREFIX");
});
