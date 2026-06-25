import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  parseAllowedRoots,
  isUnderAllowedRoot,
  isExcludedFolder,
  assertUnderAllowedRoot,
  PathNotAllowedError,
} from "@/lib/media/indexRoots.js";

// Use the real OS-specific temp root so absolute-path checks are cross-platform.
const ROOT = path.resolve(path.join(process.cwd(), "fixture-root"));
const OTHER = path.resolve(path.join(process.cwd(), "other-root"));

test("parseAllowedRoots splits, trims, and drops empty/relative entries", () => {
  const parsed = parseAllowedRoots(`${ROOT} ,  ${OTHER} , , relative/path`);
  assert.deepEqual(parsed, [ROOT, OTHER]);
});

test("parseAllowedRoots returns [] for empty/undefined", () => {
  assert.deepEqual(parseAllowedRoots(undefined), []);
  assert.deepEqual(parseAllowedRoots(""), []);
  assert.deepEqual(parseAllowedRoots("   "), []);
});

test("isUnderAllowedRoot accepts the root itself and descendants", () => {
  assert.equal(isUnderAllowedRoot(ROOT, [ROOT]), true);
  assert.equal(isUnderAllowedRoot(path.join(ROOT, "a", "b.jpg"), [ROOT]), true);
});

test("isUnderAllowedRoot rejects siblings, traversal, and empty config", () => {
  assert.equal(isUnderAllowedRoot(OTHER, [ROOT]), false);
  assert.equal(isUnderAllowedRoot(path.join(ROOT, "..", "escape"), [ROOT]), false);
  assert.equal(isUnderAllowedRoot(ROOT, []), false);
});

test("assertUnderAllowedRoot returns the resolved path when allowed", () => {
  const messy = path.join(ROOT, "sub", "..", "file.pdf");
  assert.equal(assertUnderAllowedRoot(messy, [ROOT]), path.resolve(messy));
});

test("assertUnderAllowedRoot throws PathNotAllowedError when outside", () => {
  assert.throws(
    () => assertUnderAllowedRoot(OTHER, [ROOT]),
    (err: unknown) => err instanceof PathNotAllowedError && (err as PathNotAllowedError).code === "PATH_NOT_ALLOWED",
  );
});

test("isExcludedFolder matches the folder itself and its descendants", () => {
  const excluded = path.join(ROOT, "@eaDir");
  assert.equal(isExcludedFolder(excluded, [excluded]), true);
  assert.equal(isExcludedFolder(path.join(excluded, "thumb.jpg"), [excluded]), true);
});

test("isExcludedFolder leaves siblings and unrelated paths alone", () => {
  const excluded = path.join(ROOT, "@eaDir");
  assert.equal(isExcludedFolder(path.join(ROOT, "photos", "a.jpg"), [excluded]), false);
  // a sibling whose name shares a prefix must not match (separator boundary)
  assert.equal(isExcludedFolder(path.join(ROOT, "@eaDir-backup"), [excluded]), false);
});

test("isExcludedFolder excludes nothing for an empty list", () => {
  assert.equal(isExcludedFolder(path.join(ROOT, "anything"), []), false);
});
