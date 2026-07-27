import test from "node:test";
import assert from "node:assert/strict";
import { matchIdentity, type MoveCandidate, type IncomingFile } from "@/lib/media/matchIdentity.js";

const MTIME = 1_700_000_000_000;

function candidate (over: Partial<MoveCandidate> & Pick<MoveCandidate, "id">): MoveCandidate {
  return {
    basename: "photo.jpg",
    sizeBytes: 4096,
    mtimeMs: MTIME,
    contentHash: null,
    ...over,
  };
}

function file (over: Partial<IncomingFile> = {}): IncomingFile {
  return { basename: "photo.jpg", sizeBytes: 4096, mtimeMs: MTIME, ...over };
}

test("no candidates means nothing to match", () => {
  assert.deepEqual(matchIdentity(file(), []), { kind: "none" });
});

test("same size, mtime and name is a move", () => {
  const c = candidate({ id: "m1" });
  const result = matchIdentity(file(), [c]);

  assert.equal(result.kind, "matched");
  assert.equal(result.kind === "matched" && result.candidate.id, "m1");
  assert.equal(result.kind === "matched" && result.via, "size-mtime-name");
});

test("same size and mtime under a different name is a rename", () => {
  const c = candidate({ id: "m1", basename: "IMG_0421.jpg" });
  const result = matchIdentity(file({ basename: "beach.jpg" }), [c]);

  assert.equal(result.kind, "matched");
  assert.equal(result.kind === "matched" && result.via, "size-mtime");
});

test("a different size is never a match, however close the rest is", () => {
  const c = candidate({ id: "m1", sizeBytes: 4097 });
  assert.deepEqual(matchIdentity(file(), [c]), { kind: "none" });
});

test("filename case differences still match (NTFS/APFS are case-insensitive)", () => {
  const c = candidate({ id: "m1", basename: "Photo.JPG" });
  const result = matchIdentity(file({ basename: "photo.jpg" }), [c]);

  assert.equal(result.kind === "matched" && result.via, "size-mtime-name");
});

test("a candidate with no recorded mtime cannot match on metadata", () => {
  const c = candidate({ id: "m1", mtimeMs: null });
  // Nothing to compare and no hash on either side — treat it as a new file
  // rather than guessing from size alone.
  assert.deepEqual(matchIdentity(file(), [c]), { kind: "none" });
});

test("an incoming file with no mtime cannot match on metadata", () => {
  const c = candidate({ id: "m1" });
  assert.deepEqual(matchIdentity(file({ mtimeMs: null }), [c]), { kind: "none" });
});

test("identical twins are reported ambiguous rather than guessed at", () => {
  const a = candidate({ id: "m1" });
  const b = candidate({ id: "m2" });
  const result = matchIdentity(file(), [a, b]);

  assert.equal(result.kind, "ambiguous");
  assert.deepEqual(result.kind === "ambiguous" && result.candidates.map(c => c.id), ["m1", "m2"]);
});

test("a hash breaks a tie the metadata could not", () => {
  const a = candidate({ id: "m1", contentHash: "aaa" });
  const b = candidate({ id: "m2", contentHash: "bbb" });
  const result = matchIdentity(file({ contentHash: "bbb" }), [a, b]);

  assert.equal(result.kind === "matched" && result.candidate.id, "m2");
  assert.equal(result.kind === "matched" && result.via, "content-hash");
});

test("a known-different hash rules a candidate out entirely", () => {
  // Size, mtime and name all agree, but the bytes provably do not.
  const c = candidate({ id: "m1", contentHash: "aaa" });
  assert.deepEqual(matchIdentity(file({ contentHash: "zzz" }), [c]), { kind: "none" });
});

test("hash matches across a rename", () => {
  const c = candidate({ id: "m1", basename: "old.jpg", mtimeMs: null, contentHash: "aaa" });
  const result = matchIdentity(file({ basename: "new.jpg", contentHash: "aaa" }), [c]);

  assert.equal(result.kind === "matched" && result.via, "content-hash");
});

test("metadata mismatch asks for a hash only when a candidate has one", () => {
  const withHash = candidate({ id: "m1", mtimeMs: 999, contentHash: "aaa" });
  assert.equal(matchIdentity(file(), [withHash]).kind, "ambiguous");

  const withoutHash = candidate({ id: "m2", mtimeMs: 999, contentHash: null });
  assert.equal(matchIdentity(file(), [withoutHash]).kind, "none");
});

test("the second pass always resolves — an ambiguous result never repeats", () => {
  // Two byte-identical copies whose hashes were never computed. The caller
  // hashes and calls again; picking one is correct because they are duplicates,
  // and crucially it terminates rather than asking for a hash forever.
  const a = candidate({ id: "m1" });
  const b = candidate({ id: "m2" });
  const first = matchIdentity(file(), [a, b]);
  assert.equal(first.kind, "ambiguous");

  const second = matchIdentity(
    file({ contentHash: "aaa" }),
    first.kind === "ambiguous" ? first.candidates : [],
  );
  assert.equal(second.kind, "matched");
});
