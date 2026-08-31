import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import {
  collisionName,
  sanitizeIngestFilename,
  writeIngestFile,
  UnsafeIngestFilenameError,
  IngestStreamTooLargeError,
} from "@/lib/media/ingestWrite.js";

// Real directories, not a fake fs: what this module exists to guarantee — that
// a collision cannot overwrite and an aborted write leaves nothing behind — is
// a property of the syscalls, so a fake would test the fake.
async function makeDir (): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "vault-ingest-"));
}

const streamOf = (text: string) => Readable.from([Buffer.from(text)]);

// ── sanitizeIngestFilename ────────────────────────────────────────────────────

test("sanitizeIngestFilename: keeps an ordinary name", () => {
  assert.equal(sanitizeIngestFilename("invoice.pdf"), "invoice.pdf");
});

test("sanitizeIngestFilename: strips POSIX and Windows directory traversal", () => {
  assert.equal(sanitizeIngestFilename("../../etc/passwd"), "passwd");
  assert.equal(sanitizeIngestFilename("..\\..\\Windows\\system32\\cmd.exe"), "cmd.exe");
  assert.equal(sanitizeIngestFilename("/etc/shadow"), "shadow");
});

test("sanitizeIngestFilename: strips characters that would fail open()", () => {
  assert.equal(sanitizeIngestFilename('re:po<rt>?.pdf'), "report.pdf");
});

test("sanitizeIngestFilename: drops trailing dots and spaces Windows would eat", () => {
  assert.equal(sanitizeIngestFilename("report.pdf. "), "report.pdf");
});

test("sanitizeIngestFilename: rejects a name with nothing left", () => {
  assert.throws(() => sanitizeIngestFilename("   "), UnsafeIngestFilenameError);
  assert.throws(() => sanitizeIngestFilename(".."), UnsafeIngestFilenameError);
  assert.throws(() => sanitizeIngestFilename("/"), UnsafeIngestFilenameError);
});

test("sanitizeIngestFilename: rejects Windows reserved device names, with or without an extension, case-insensitively", () => {
  assert.throws(() => sanitizeIngestFilename("CON"), UnsafeIngestFilenameError);
  assert.throws(() => sanitizeIngestFilename("nul.txt"), UnsafeIngestFilenameError);
  assert.throws(() => sanitizeIngestFilename("COM1"), UnsafeIngestFilenameError);
  assert.throws(() => sanitizeIngestFilename("LPT9.LOG"), UnsafeIngestFilenameError);
});

test("sanitizeIngestFilename: a reserved name as a prefix, not the whole stem, is not rejected", () => {
  assert.equal(sanitizeIngestFilename("CONSOLE.txt"), "CONSOLE.txt");
  assert.equal(sanitizeIngestFilename("NULL.txt"), "NULL.txt");
});

// ── collisionName ─────────────────────────────────────────────────────────────

test("collisionName: inserts the counter before the extension", () => {
  assert.equal(collisionName("report.pdf", 2), "report (2).pdf");
  assert.equal(collisionName("archive.tar.gz", 3), "archive.tar (3).gz");
});

test("collisionName: an extension-less name keeps its shape", () => {
  assert.equal(collisionName("README", 2), "README (2)");
});

// ── writeIngestFile ───────────────────────────────────────────────────────────

test("writeIngestFile: writes the bytes under the requested name", async () => {
  const dir = await makeDir();
  const result = await writeIngestFile(dir, "notes.txt", streamOf("hello"));

  assert.equal(result.savedAs, "notes.txt");
  assert.equal(result.renamed, false);
  assert.equal(result.sizeBytes, 5);
  assert.equal(await readFile(result.path, "utf8"), "hello");
});

test("writeIngestFile: an existing file is never overwritten", async () => {
  const dir = await makeDir();
  await writeFile(path.join(dir, "notes.txt"), "original");

  const result = await writeIngestFile(dir, "notes.txt", streamOf("new"));

  assert.equal(result.savedAs, "notes (2).txt");
  assert.equal(result.renamed, true);
  assert.equal(await readFile(path.join(dir, "notes.txt"), "utf8"), "original");
  assert.equal(await readFile(result.path, "utf8"), "new");
});

test("writeIngestFile: collisions keep counting up", async () => {
  const dir = await makeDir();
  await writeIngestFile(dir, "a.txt", streamOf("1"));
  await writeIngestFile(dir, "a.txt", streamOf("2"));
  const third = await writeIngestFile(dir, "a.txt", streamOf("3"));

  assert.equal(third.savedAs, "a (3).txt");
  assert.deepEqual((await readdir(dir)).sort(), ["a (2).txt", "a (3).txt", "a.txt"]);
});

test("writeIngestFile: concurrent sends of one name never collide", async () => {
  const dir = await makeDir();
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) => writeIngestFile(dir, "same.txt", streamOf(String(i)))),
  );

  const names = results.map(r => r.savedAs);
  assert.equal(new Set(names).size, 8, "every send got its own filename");
  assert.equal((await readdir(dir)).length, 8);
});

test("writeIngestFile: a traversing name lands in the folder, not above it", async () => {
  const dir = await makeDir();
  const result = await writeIngestFile(dir, "../escaped.txt", streamOf("x"));

  assert.equal(path.dirname(result.path), dir);
  assert.deepEqual(await readdir(dir), ["escaped.txt"]);
});

test("writeIngestFile: an aborted send leaves no partial file behind", async () => {
  const dir = await makeDir();
  const failing = new Readable({
    read () {
      this.push(Buffer.from("partial"));
      this.destroy(new Error("connection reset"));
    },
  });

  await assert.rejects(() => writeIngestFile(dir, "big.bin", failing), /connection reset/);
  assert.deepEqual(await readdir(dir), [], "nothing left for the watcher to index");
});

test("writeIngestFile: an unusable name is rejected before anything is created", async () => {
  const dir = await makeDir();
  await assert.rejects(() => writeIngestFile(dir, "..", streamOf("x")), UnsafeIngestFilenameError);
  assert.deepEqual(await readdir(dir), []);
});

// ── writeIngestFile: maxBytes ────────────────────────────────────────────────

test("writeIngestFile: a body over maxBytes is rejected and nothing is left on disk", async () => {
  const dir = await makeDir();
  const big = Readable.from([Buffer.from("x".repeat(4)), Buffer.from("y".repeat(4))]);

  await assert.rejects(() => writeIngestFile(dir, "big.bin", big, 5), IngestStreamTooLargeError);
  assert.deepEqual(await readdir(dir), [], "nothing left on disk once the cap is crossed");
});

test("writeIngestFile: exceeding maxBytes throws IngestStreamTooLargeError with the shared error code", async () => {
  const dir = await makeDir();
  const big = streamOf("way too much data for the cap");

  await assert.rejects(
    () => writeIngestFile(dir, "big.bin", big, 4),
    (err: unknown) =>
      err instanceof IngestStreamTooLargeError && (err as IngestStreamTooLargeError).code === "INGEST_TOO_LARGE",
  );
});

test("writeIngestFile: maxBytes larger than the body still writes normally", async () => {
  const dir = await makeDir();
  const result = await writeIngestFile(dir, "notes.txt", streamOf("hello"), 1024);

  assert.equal(result.sizeBytes, 5);
  assert.equal(await readFile(result.path, "utf8"), "hello");
});
