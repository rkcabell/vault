//File: apps/api/src/tests/api/lib/processTextJob.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import type { StorageAdapter } from "@/adapters/storage/types.js";
import { processTextJob } from "@/lib/text/processTextJob.js";
import { MAX_TEXT_CHARS } from "@/lib/media/processingSupport.js";

/** Build a fake StorageAdapter whose getObjectStream yields the given buffer (or null). */
function fakeStorage (buffer: Buffer | null): StorageAdapter {
  return {
    getObjectStream: async () =>
      buffer ? { body: Readable.from(buffer), etag: null, contentLength: buffer.length } : null,
  } as unknown as StorageAdapter;
}

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

test("processTextJob extracts native text for PDFs", async () => {
  const pdf = buildMinimalPdf("Hello");

  const result = await processTextJob({
    storage: fakeStorage(pdf),
    bucket: "bucket",
    key: "file.pdf",
    mimeType: "application/pdf",
  });

  assert.equal(result.textSource, "NATIVE");
  assert.equal(result.rawText, "Hello");
  assert.equal(result.pages?.length, 1);
});

test("processTextJob reads plain text directly, no OCR", async () => {
  let ocrCalled = false;
  const result = await processTextJob(
    { storage: fakeStorage(Buffer.from("# Heading\nbody text", "utf8")), bucket: "b", key: "notes.md", mimeType: "text/markdown" },
    { ocrWithOcrmypdf: async () => { ocrCalled = true; return { ocrPdf: Buffer.alloc(0) }; } },
  );

  assert.equal(result.textSource, "NATIVE");
  assert.equal(result.rawText, "# Heading\nbody text");
  assert.equal(result.pages, null);
  assert.equal(result.needsOcr, false);
  assert.equal(ocrCalled, false, "plain text must not invoke ocrmypdf");
});

test("processTextJob strips a UTF-8 BOM from plain text", async () => {
  const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("plain", "utf8")]);
  const result = await processTextJob(
    { storage: fakeStorage(withBom), bucket: "b", key: "f.txt", mimeType: "text/plain" },
  );
  assert.equal(result.rawText, "plain");
});

test("processTextJob truncates plain text to the char cap", async () => {
  const big = "a".repeat(MAX_TEXT_CHARS + 100);
  const result = await processTextJob(
    { storage: fakeStorage(Buffer.from(big, "utf8")), bucket: "b", key: "big.txt", mimeType: "text/plain" },
  );
  assert.equal(result.rawText.length, MAX_TEXT_CHARS);
});

test("processTextJob runs OCRmyPDF for non-PDFs", async () => {
  const ocrCalls: unknown[] = [];
  const result = await processTextJob(
    {
      storage: fakeStorage(Buffer.from("ignored")),
      bucket: "bucket",
      key: "file.png",
      mimeType: "image/png",
      language: "eng",
      rotation: "90",
    },
    {
      getObjectBuffer: async () => Buffer.from("fake image bytes"),
      ocrWithOcrmypdf: async args => {
        ocrCalls.push(args);
        return { ocrPdf: buildMinimalPdf("Hello from OCR") };
      },
    },
  );

  assert.equal(result.textSource, "OCR");
  assert.equal(result.rawText, "Hello from OCR");
  assert.equal(result.pages?.length, 1);
  assert.equal(result.needsOcr, false);
  assert.equal(ocrCalls.length, 1);
  assert.equal((ocrCalls[0] as { language: string }).language, "eng");
});

test("processTextJob skips OCR and returns empty for blank images", async () => {
  const ocrCalls: unknown[] = [];
  const result = await processTextJob(
    {
      storage: fakeStorage(Buffer.from("ignored")),
      bucket: "bucket",
      key: "file.png",
      mimeType: "image/png",
    },
    {
      getObjectBuffer: async () => Buffer.from("fake image bytes"),
      ocrWithOcrmypdf: async args => {
        ocrCalls.push(args);
        return { ocrPdf: buildMinimalPdf("should not reach") };
      },
      isBlankImage: async () => true,
    },
  );

  assert.equal(result.textSource, "OCR");
  assert.equal(result.rawText, "");
  assert.equal(result.needsOcr, false);
  assert.equal(ocrCalls.length, 0, "ocrmypdf must not be called for blank images");
});

test("processTextJob runs OCR normally when blank check returns false", async () => {
  const ocrCalls: unknown[] = [];
  const result = await processTextJob(
    {
      storage: fakeStorage(Buffer.from("ignored")),
      bucket: "bucket",
      key: "file.png",
      mimeType: "image/png",
    },
    {
      getObjectBuffer: async () => Buffer.from("fake image bytes"),
      ocrWithOcrmypdf: async args => {
        ocrCalls.push(args);
        return { ocrPdf: buildMinimalPdf("Real text") };
      },
      isBlankImage: async () => false,
    },
  );

  assert.equal(result.textSource, "OCR");
  assert.equal(result.rawText, "Real text");
  assert.equal(ocrCalls.length, 1, "ocrmypdf must run when image is not blank");
});

test("processTextJob throws when PDF source is missing", async () => {
  await assert.rejects(
    processTextJob({
      storage: fakeStorage(null),
      bucket: "bucket",
      key: "file.pdf",
      mimeType: "application/pdf",
    }),
    /Source.*not ready|SOURCE_NOT_READY/i,
  );
});
