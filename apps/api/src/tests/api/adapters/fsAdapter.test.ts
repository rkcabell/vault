import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { createFsAdapter, InvalidStorageKeyError } from "@/adapters/storage/fsAdapter.js";
import { streamToBuffer } from "@/lib/streams/toBuffer.js";

const BUCKET = "test-bucket"; // ignored by the fs adapter, present to satisfy the interface

let base: string;

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), "vault-fs-"));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

test("putObject (buffer) then getObjectStream round-trips and creates nested dirs", async () => {
  const fs = createFsAdapter({ basePath: base });
  const key = "user-1/media-1/hello.txt";
  await fs.putObject({ bucket: BUCKET, key, body: Buffer.from("hello world"), contentType: "text/plain" });

  const onDisk = await stat(path.join(base, key));
  assert.ok(onDisk.isFile());

  const res = await fs.getObjectStream({ bucket: BUCKET, key });
  assert.ok(res);
  assert.equal(res!.contentLength, 11);
  const buf = await streamToBuffer(res!.body);
  assert.equal(buf.toString(), "hello world");
});

test("putObject (readable stream) round-trips", async () => {
  const fs = createFsAdapter({ basePath: base });
  const key = "user-1/media-2/stream.bin";
  await fs.putObject({
    bucket: BUCKET,
    key,
    body: Readable.from([Buffer.from("ab"), Buffer.from("cd")]),
    contentType: "application/octet-stream",
  });
  const res = await fs.getObjectStream({ bucket: BUCKET, key });
  const buf = await streamToBuffer(res!.body);
  assert.equal(buf.toString(), "abcd");
});

test("putObject overwrites an existing object atomically", async () => {
  const fs = createFsAdapter({ basePath: base });
  const key = "thumbs/m.webp";
  await fs.putObject({ bucket: BUCKET, key, body: Buffer.from("v1"), contentType: "x" });
  await fs.putObject({ bucket: BUCKET, key, body: Buffer.from("v2-longer"), contentType: "x" });
  const res = await fs.getObjectStream({ bucket: BUCKET, key });
  assert.equal((await streamToBuffer(res!.body)).toString(), "v2-longer");
});

test("getObjectStream returns null for a missing object", async () => {
  const fs = createFsAdapter({ basePath: base });
  const res = await fs.getObjectStream({ bucket: BUCKET, key: "user-1/nope/x.txt" });
  assert.equal(res, null);
});

test("objectExists reflects presence", async () => {
  const fs = createFsAdapter({ basePath: base });
  const key = "user-1/m/x.txt";
  assert.equal(await fs.objectExists({ bucket: BUCKET, key }), false);
  await fs.putObject({ bucket: BUCKET, key, body: Buffer.from("x"), contentType: "x" });
  assert.equal(await fs.objectExists({ bucket: BUCKET, key }), true);
});

test("deleteIfPresent removes the object and is a no-op when absent", async () => {
  const fs = createFsAdapter({ basePath: base });
  const key = "user-1/m/x.txt";
  await fs.putObject({ bucket: BUCKET, key, body: Buffer.from("x"), contentType: "x" });
  await fs.deleteIfPresent({ bucket: BUCKET, key });
  assert.equal(await fs.objectExists({ bucket: BUCKET, key }), false);
  // second delete must not throw
  await fs.deleteIfPresent({ bucket: BUCKET, key });
});

test("usage sums committed object sizes and counts, ignoring temp files", async () => {
  const fs = createFsAdapter({ basePath: base });
  await fs.putObject({ bucket: BUCKET, key: "user-1/a/1.txt", body: Buffer.from("aaa"), contentType: "x" });
  await fs.putObject({ bucket: BUCKET, key: "user-1/b/2.txt", body: Buffer.from("bbbbb"), contentType: "x" });
  // a stray in-flight temp file must be excluded
  await mkdir(path.join(base, "user-1/c"), { recursive: true });
  await writeFile(path.join(base, "user-1/c/3.txt.tmp-abc"), "ignored");

  const u = await fs.usage({ bucket: BUCKET });
  assert.equal(u.objectCount, 2);
  assert.equal(u.sizeBytes, 8);
});

test("usage on an uncreated base path returns zero", async () => {
  const fs = createFsAdapter({ basePath: path.join(base, "does-not-exist-yet") });
  const u = await fs.usage({ bucket: BUCKET });
  assert.deepEqual(u, { sizeBytes: 0, objectCount: 0 });
});

test("rejects keys that escape the base path", async () => {
  const fs = createFsAdapter({ basePath: base });
  for (const key of ["../escape.txt", "user-1/../../etc/passwd", "/etc/passwd"]) {
    await assert.rejects(
      () => fs.objectExists({ bucket: BUCKET, key }),
      (err: unknown) => err instanceof InvalidStorageKeyError,
      `expected rejection for key ${key}`,
    );
  }
});

test("presign URLs point at the API proxy route with encoded segments", async () => {
  const fs = createFsAdapter({ basePath: base, apiBaseUrl: "http://localhost:8000/" });
  const put = await fs.presignPut({ bucket: BUCKET, key: "user-1/m/my file.txt", contentType: "text/plain", expiresSeconds: 600 });
  const get = await fs.presignGet({ bucket: BUCKET, key: "user-1/m/my file.txt", expiresSeconds: 600 });
  assert.equal(put, "http://localhost:8000/api/storage/blob/user-1/m/my%20file.txt");
  assert.equal(get, put);
});
