import test from "node:test";
import assert from "node:assert/strict";
import { normalizeTag, normalizeTags, TagValidationError, TAG_RULES } from "@/lib/tags/normalizeTags.js";

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

// ── normalizeTag (singular) ───────────────────────────────────────────────────

test("normalizeTag: rejects non-string input", () => {
  expectTagError(() => normalizeTag(42), "INVALID_TYPE");
  expectTagError(() => normalizeTag(null), "INVALID_TYPE");
});

test("normalizeTag: strips leading and trailing dashes", () => {
  assert.equal(normalizeTag("-foo-"), "foo");
  assert.equal(normalizeTag("--bar--"), "bar");
});

test("normalizeTag: collapses all-dash/space input to EMPTY error", () => {
  expectTagError(() => normalizeTag("---"), "EMPTY");
  expectTagError(() => normalizeTag("   "), "EMPTY");
});

// ── normalizeTags edge cases ───────────────────────────────────────────────────

test("normalizeTags: null and undefined return empty array", () => {
  assert.deepEqual(normalizeTags(null), []);
  assert.deepEqual(normalizeTags(undefined), []);
});

test("normalizeTags: non-string non-array input throws INVALID_TYPE", () => {
  expectTagError(() => normalizeTags(42), "INVALID_TYPE");
  expectTagError(() => normalizeTags({ tag: "foo" }), "INVALID_TYPE");
});

test("normalizeTags: accepts MAX_TAGS tags", () => {
  const tags = Array.from({ length: TAG_RULES.MAX_TAGS }, (_, i) => `tag${i}`);
  assert.equal(normalizeTags(tags).length, TAG_RULES.MAX_TAGS);
});

test("normalizeTags: rejects more than MAX_TAGS unique tags", () => {
  const tags = Array.from({ length: TAG_RULES.MAX_TAGS + 1 }, (_, i) => `tag${i}`);
  expectTagError(() => normalizeTags(tags), "TOO_MANY");
});
