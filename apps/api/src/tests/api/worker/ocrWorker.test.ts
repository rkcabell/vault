//File: apps/api/src/tests/api/worker/ocrWorker.test.ts

import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { HeadObjectCommand } from "@aws-sdk/client-s3";
import { s3 } from "@/plugins/s3Client.js";
import { prisma } from "@vault/db";
import { processOcrJob, type OcrDeps } from "@/worker/ocrWorker.js";

function buildMinimalPdf (text: string): Buffer {
  const stream = `BT /F1 24 Tf 72 120 Td (${text}) Tj ET`;
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n",
    `4 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`,
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  ];

  let offset = 0;
  const chunks: string[] = [];
  const offsets: number[] = [0];
  const header = "%PDF-1.4\n";
  chunks.push(header);
  offset += header.length;

  for (const obj of objects) {
    offsets.push(offset);
    chunks.push(obj);
    offset += obj.length;
  }

  const xrefOffset = offset;
  const xrefLines = ["xref\n", "0 6\n", "0000000000 65535 f \n"];
  for (let i = 1; i <= 5; i += 1) {
    const line = `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
    xrefLines.push(line);
  }

  const trailer = `trailer\n<< /Root 1 0 R /Size 6 >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  chunks.push(xrefLines.join(""));
  chunks.push(trailer);

  return Buffer.from(chunks.join(""), "ascii");
}

process.env.NODE_ENV = "test";
process.env.S3_BUCKET = "test-bucket";
process.env.REDIS_URL = "redis://localhost:6379";
process.env.OCR_QUEUE = "ocr_queue";

const originalSend = s3.send.bind(s3);
const originalFindUnique = prisma.media.findUnique.bind(prisma.media);
const originalUpdateMany = prisma.media.updateMany.bind(prisma.media);
const originalUpsert = prisma.document.upsert.bind(prisma.document);
const originalTransaction = (prisma as any).$transaction.bind(prisma);

function mockS3Send (fn: (cmd: any) => any) {
  (s3 as any).send = async (cmd: any) => fn(cmd);
}

function mockMediaFindUnique (result: any) {
  (prisma.media as any).findUnique = async () => result;
}

function mockMediaUpdate (fn: (args: any) => any) {
  (prisma.media as any).updateMany = async (args: any) => fn(args);
}

function mockDocumentUpsert (fn: (args: any) => any) {
  (prisma.document as any).upsert = async (args: any) => fn(args);
}

function mockOcrDeps (): OcrDeps {
  return {
    prisma,
    s3,
    bucket: "test-bucket",
    enqueueOcr: async () => {},
    sleep: async () => {},
    textDeps: {
      getObjectBuffer: async () => Buffer.from("image-bytes"),
      ocrWithOcrmypdf: async () => ({ ocrPdf: buildMinimalPdf("mock OCR text") }),
    },
  };
}

afterEach(() => {
  (s3 as any).send = originalSend;
  (prisma.media as any).findUnique = originalFindUnique;
  (prisma.media as any).updateMany = originalUpdateMany;
  (prisma.document as any).upsert = originalUpsert;
  (prisma as any).$transaction = originalTransaction;
});

/** Stub $transaction so addTagIfAbsent never touches the real DB. */
function mockNoopTransaction () {
  (prisma as any).$transaction = async (fn: (tx: any) => Promise<void>) =>
    fn({
      media: { findUnique: async () => null, update: async () => ({}) },
      tag:   { upsert: async () => ({}) },
    });
}

test("processOcrJob returns when media is missing", async () => {
  let s3Called = false;

  mockS3Send(() => {
    s3Called = true;
    return {};
  });
  mockMediaFindUnique(null);

  await processOcrJob(mockOcrDeps(), { mediaId: "missing-media" });
  assert.equal(s3Called, false);
});

test("processOcrJob writes OCR text for non-PDF media", async () => {
  mockS3Send(cmd => {
    if (cmd instanceof HeadObjectCommand) return {};
    throw new Error("unexpected s3 command");
  });

  mockMediaFindUnique({ id: "media-1", storageKey: "orig/key", mimeType: "image/png" });
  mockNoopTransaction();

  let upsertArgs: unknown = null;
  mockDocumentUpsert(args => {
    upsertArgs = args;
    return { count: 1 };
  });

  let updateArgs: unknown = null;
  mockMediaUpdate(args => {
    updateArgs = args;
    return { count: 1 };
  });

  await processOcrJob(mockOcrDeps(), { mediaId: "media-1" });

  const upsertData = upsertArgs as { update: { textSource: string; rawText: string } };
  assert.equal(upsertData.update.textSource, "OCR");
  assert.equal(upsertData.update.rawText, "mock OCR text");
  assert.deepEqual((updateArgs as { data: unknown }).data, { textState: "READY" });
});

test("processOcrJob throws when source is not ready", async () => {
  mockS3Send(() => {
    throw new Error("not found");
  });

  mockMediaFindUnique({ id: "media-2", storageKey: "orig/missing", mimeType: "image/png" });
  mockMediaUpdate(() => ({} as any));
  mockDocumentUpsert(() => ({} as any));

  await assert.rejects(processOcrJob(mockOcrDeps(), { mediaId: "media-2" }), /Source not ready/);
});
