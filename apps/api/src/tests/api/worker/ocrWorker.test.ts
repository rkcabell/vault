//File: apps/api/src/tests/api/worker/ocrWorker.test.ts

import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { HeadObjectCommand } from "@aws-sdk/client-s3";
import { s3 } from "../../../plugins/s3Client.js";
import { prisma } from "../../../plugins/prismaClient.js";

process.env.NODE_ENV = "test";
process.env.S3_BUCKET = "test-bucket";
process.env.REDIS_URL = "redis://localhost:6379";
process.env.OCR_QUEUE = "ocr_queue";

const { handleJob } = await import("../../../worker/ocrWorker.js");

const originalSend = s3.send.bind(s3);
const originalFindUnique = prisma.media.findUnique.bind(prisma.media);
const originalUpdate = prisma.media.update.bind(prisma.media);
const originalUpsert = prisma.document.upsert.bind(prisma.document);

function mockS3Send (fn: (cmd: any) => any) {
  (s3 as any).send = async (cmd: any) => fn(cmd);
}

function mockMediaFindUnique (result: any) {
  (prisma.media as any).findUnique = async () => result;
}

function mockMediaUpdate (fn: (args: any) => any) {
  (prisma.media as any).update = async (args: any) => fn(args);
}

function mockDocumentUpsert (fn: (args: any) => any) {
  (prisma.document as any).upsert = async (args: any) => fn(args);
}

afterEach(() => {
  (s3 as any).send = originalSend;
  (prisma.media as any).findUnique = originalFindUnique;
  (prisma.media as any).update = originalUpdate;
  (prisma.document as any).upsert = originalUpsert;
});

test("handleJob returns when media is missing", async () => {
  let s3Called = false;

  mockS3Send(() => {
    s3Called = true;
    return {};
  });
  mockMediaFindUnique(null);

  await handleJob({ mediaId: "missing-media" });
  assert.equal(s3Called, false);
});

test("handleJob writes OCR text for non-PDF media", async () => {
  mockS3Send(cmd => {
    if (cmd instanceof HeadObjectCommand) return {};
    throw new Error("unexpected s3 command");
  });

  mockMediaFindUnique({ id: "media-1", storageKey: "orig/key", mimeType: "image/png" });

  let upsertArgs: unknown = null;
  mockDocumentUpsert(args => {
    upsertArgs = args;
    return {} as any;
  });

  let updateArgs: unknown = null;
  mockMediaUpdate(args => {
    updateArgs = args;
    return {} as any;
  });

  await handleJob({ mediaId: "media-1" });

  const upsertData = upsertArgs as { update: { textSource: string; rawText: string } };
  assert.equal(upsertData.update.textSource, "OCR");
  assert.ok(upsertData.update.rawText.includes("OCR STUB"));
  assert.deepEqual((updateArgs as { data: unknown }).data, { textState: "READY" });
});

test("handleJob throws when source is not ready", async () => {
  mockS3Send(() => {
    throw new Error("not found");
  });

  mockMediaFindUnique({ id: "media-2", storageKey: "orig/missing", mimeType: "image/png" });
  mockMediaUpdate(() => ({} as any));
  mockDocumentUpsert(() => ({} as any));

  await assert.rejects(handleJob({ mediaId: "media-2" }), /SOURCE_NOT_READY/);
});
