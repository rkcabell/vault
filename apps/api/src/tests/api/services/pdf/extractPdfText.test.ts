//File: apps/api/src/tests/api/services/pdf/extractPdfText.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { extractPdfText } from "@/services/pdf/extractPdfText.js";

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

/** Build a multi-page PDF where every page has an empty content stream (no text). */
function buildBlankPdf (numPages: number): Buffer {
  const chunks: string[] = [];
  let offset = 0;

  const push = (s: string) => {
    chunks.push(s);
    offset += s.length;
  };

  const header = "%PDF-1.4\n";
  push(header);

  // We'll track object offsets by index (1-based)
  const objOffsets: number[] = [0]; // placeholder for index 0

  // Object 1: Catalog
  objOffsets[1] = offset;
  push("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");

  // Object 2: Pages — kids will be objects 3, 4, … (3 + i for i in 0..numPages-1)
  const kidRefs = Array.from({ length: numPages }, (_, i) => `${3 + i} 0 R`).join(" ");
  objOffsets[2] = offset;
  push(`2 0 obj\n<< /Type /Pages /Kids [${kidRefs}] /Count ${numPages} >>\nendobj\n`);

  // Objects 3..(3+numPages-1): blank Page objects (no content stream)
  for (let i = 0; i < numPages; i += 1) {
    objOffsets[3 + i] = offset;
    push(
      `${3 + i} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\n`,
    );
  }

  const totalObjs = 2 + numPages; // objects 1 through (2+numPages)
  const xrefOffset = offset;
  const xrefLines = [`xref\n`, `0 ${totalObjs + 1}\n`, `0000000000 65535 f \n`];
  for (let i = 1; i <= totalObjs; i += 1) {
    xrefLines.push(`${String(objOffsets[i]).padStart(10, "0")} 00000 n \n`);
  }
  push(xrefLines.join(""));
  push(`trailer\n<< /Root 1 0 R /Size ${totalObjs + 1} >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  return Buffer.from(chunks.join(""), "ascii");
}

test("extractPdfText reads text from a minimal PDF", async () => {
  const pdf = buildMinimalPdf("Hello");
  const result = await extractPdfText(pdf);

  assert.equal(result.pages.length, 1);
  assert.equal(result.pages[0]?.text, "Hello");
  assert.equal(result.fullText, "Hello");
  assert.equal(result.numPages, 1);
});

test("extractPdfText exits early after 3 blank pages and sets needsOcr=true", async () => {
  const PAGE_COUNT = 10;
  const pdf = buildBlankPdf(PAGE_COUNT);

  let progressCallCount = 0;
  const result = await extractPdfText(pdf, {
    onProgress: () => { progressCallCount += 1; },
  });

  assert.equal(result.needsOcr, true);
  assert.equal(result.totalChars, 0);
  // numPages must still reflect the real document page count
  assert.equal(result.numPages, PAGE_COUNT);
  // Early exit fires after page 3 — only 3 pages should have been scanned
  // (+1 for the initial progress(0) call)
  assert.ok(
    progressCallCount <= 4,
    `Expected at most 4 progress calls (initial + 3 pages), got ${progressCallCount}`,
  );
});

test("extractPdfText does not exit early when the first page has text", async () => {
  // Text must exceed MIN_PAGE_CHARS (20) so pagesWithText is counted.
  const pdf = buildMinimalPdf("This page has enough text to count.");
  const result = await extractPdfText(pdf);

  assert.equal(result.needsOcr, false);
  assert.ok(result.totalChars > 0);
});
