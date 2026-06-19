import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { openSourceStream, readSourceBuffer } from "@/adapters/storage/openSource.js";
import { PathNotAllowedError } from "@/lib/media/indexRoots.js";
import { streamToBuffer } from "@/lib/streams/toBuffer.js";

const BUCKET = "test-bucket";

let base: string;
beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), "vault-src-"));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

// Storage adapter stub: only getObjectStream is exercised by openSourceStream.
function storageReturning (payload: string | null) {

  return {
    getObjectStream: async () =>
      payload === null
        ? null
        : { body: Readable.from([Buffer.from(payload)]), etag: null, contentLength: payload.length },
  } as any;
}

test("managed branch (no sourcePath) delegates to storage.getObjectStream", async () => {
  const res = await openSourceStream({
    storage: storageReturning("managed bytes"),
    bucket: BUCKET,
    storageKey: "u/m/file.txt",
    allowedRoots: [],
  });
  assert.ok(res);
  assert.equal((await streamToBuffer(res!.body)).toString(), "managed bytes");
});

test("in-place branch reads the file from disk and reports its size", async () => {
  const file = path.join(base, "doc.txt");
  await writeFile(file, "on disk");

  const res = await openSourceStream({
    storage: storageReturning(null), // must NOT be consulted for in-place
    bucket: BUCKET,
    storageKey: `external/u/m/doc.txt`,
    sourcePath: file,
    allowedRoots: [base],
  });
  assert.ok(res);
  assert.equal(res!.contentLength, "on disk".length);
  assert.equal((await streamToBuffer(res!.body)).toString(), "on disk");
});

test("in-place branch returns null when the file is missing", async () => {
  const res = await openSourceStream({
    storage: storageReturning(null),
    bucket: BUCKET,
    storageKey: "external/u/m/gone.txt",
    sourcePath: path.join(base, "gone.txt"),
    allowedRoots: [base],
  });
  assert.equal(res, null);
});

test("in-place branch throws when sourcePath escapes the allow-list", async () => {
  await assert.rejects(
    openSourceStream({
      storage: storageReturning(null),
      bucket: BUCKET,
      storageKey: "external/u/m/x",
      sourcePath: path.join(base, "..", "escape.txt"),
      allowedRoots: [base],
    }),
    (err: unknown) => err instanceof PathNotAllowedError,
  );
});

test("readSourceBuffer returns the bytes for an in-place file", async () => {
  const file = path.join(base, "buf.bin");
  await writeFile(file, "buffer me");
  const buf = await readSourceBuffer({
    storage: storageReturning(null),
    bucket: BUCKET,
    storageKey: "external/u/m/buf.bin",
    sourcePath: file,
    allowedRoots: [base],
  });
  assert.ok(buf);
  assert.equal(buf!.toString(), "buffer me");
});

test("readSourceBuffer re-throws allow-list violations instead of swallowing them", async () => {
  await assert.rejects(
    readSourceBuffer({
      storage: storageReturning(null),
      bucket: BUCKET,
      storageKey: "external/u/m/x",
      sourcePath: path.join(base, "..", "escape.bin"),
      allowedRoots: [base],
    }),
    (err: unknown) => err instanceof PathNotAllowedError,
  );
});
