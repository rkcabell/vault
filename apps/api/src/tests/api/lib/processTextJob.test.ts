//File: apps/api/src/tests/api/lib/processTextJob.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import type { S3Client } from "@aws-sdk/client-s3";
import { processTextJob } from "@/lib/text/processTextJob.js";

function buildMinimalPdf (text: string): Buffer {
  const stream = `BT /F1 24 Tf 72 120 Td (${text}) Tj ET`;
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n",
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

test("processTextJob extracts native text for PDFs", async () => {
  const pdf = buildMinimalPdf("Hello");
  const s3 = {
    send: async () => ({ Body: Readable.from(pdf) }),
  } as unknown as S3Client;

  const result = await processTextJob({
    s3,
    bucket: "bucket",
    key: "file.pdf",
    mimeType: "application/pdf",
  });

  assert.equal(result.textSource, "NATIVE");
  assert.equal(result.rawText, "Hello");
  assert.equal(result.pages?.length, 1);
});

test("processTextJob returns OCR stub for non-PDFs", async () => {
  const s3 = { send: async () => ({}) } as unknown as S3Client;
  const result = await processTextJob({
    s3,
    bucket: "bucket",
    key: "file.png",
    mimeType: "image/png",
  });

  assert.equal(result.textSource, "OCR");
  assert.ok(result.rawText.includes("STUB: File processed"));
  assert.equal(result.pages, null);
});

test("processTextJob throws when PDF source is missing", async () => {
  const s3 = {
    send: async () => ({ Body: null }),
  } as unknown as S3Client;

  await assert.rejects(
    processTextJob({
      s3,
      bucket: "bucket",
      key: "file.pdf",
      mimeType: "application/pdf",
    }),
    /SOURCE_NOT_READY/,
  );
});
