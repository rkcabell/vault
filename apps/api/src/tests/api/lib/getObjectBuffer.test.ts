//File: apps/api/src/tests/api/lib/getObjectBuffer.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import type { S3Client } from "@aws-sdk/client-s3";
import { getObjectBuffer } from "@/adapters/s3/getObjectBuffer.js";

test("getObjectBuffer returns buffer from stream body", async () => {
  const payload = Buffer.from("hello");
  const s3 = {
    send: async () => ({ Body: Readable.from(payload) }),
  } as unknown as S3Client;

  const result = await getObjectBuffer(s3, "bucket", "key");
  assert.ok(result);
  assert.equal(result?.toString("utf-8"), "hello");
});

test("getObjectBuffer returns null on errors", async () => {
  const s3 = {
    send: async () => {
      throw new Error("boom");
    },
  } as unknown as S3Client;

  const result = await getObjectBuffer(s3, "bucket", "key");
  assert.equal(result, null);
});
