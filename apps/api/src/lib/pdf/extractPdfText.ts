// File: apps/api/src/lib/pdf/extractPdfText.ts
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { MIN_PAGE_CHARS, shouldFallbackToOcr } from "./shouldFallbackToOcr.js";

export type PdfTextPage = { pageNumber: number; text: string; numChars: number };

let pdfjsPromise: Promise<any> | null = null;

async function loadPdfJs () {
  if (!pdfjsPromise) {
    pdfjsPromise = import("pdfjs-dist/legacy/build/pdf.mjs").catch(
      () => import("pdfjs-dist/legacy/build/pdf.mjs"),
    );
  }

  const mod = await pdfjsPromise;
  const pdfjs = (mod as { default?: unknown }).default ?? mod;
  const gwo = (pdfjs as { GlobalWorkerOptions?: { workerSrc?: string } }).GlobalWorkerOptions;
  if (gwo) {
    const require = createRequire(import.meta.url);

    // Try common worker filenames
    const candidates = [
      "pdfjs-dist/legacy/build/pdf.worker.mjs",
      "pdfjs-dist/legacy/build/pdf.worker.min.mjs",
      "pdfjs-dist/build/pdf.worker.mjs",
      "pdfjs-dist/build/pdf.worker.min.mjs",
    ];

    let resolved: string | null = null;
    for (const spec of candidates) {
      try {
        resolved = require.resolve(spec);
        break;
      } catch {
        //
      }
    }

    if (resolved) {
      gwo.workerSrc = pathToFileURL(resolved).toString();
    } else {
      delete (gwo as any).workerSrc;
    }
  }

  return pdfjs;
}

export async function extractPdfText (input: Uint8Array | Buffer) {
  const pdfjs = await loadPdfJs();
  const data = toPdfJsData(input);

  const loadingTask = pdfjs.getDocument({
    data,
    disableWorker: true, // keep workers off in API/tests
  });

  const doc = await loadingTask.promise;
  console.log("[extractPdfText] loaded pdf pages=", doc.numPages, "bytes=", data.byteLength);

  const pages: PdfTextPage[] = [];
  let totalChars = 0;
  let pagesWithText = 0;

  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    const items = content.items as Array<{ str?: string }>;

    const text = items
      .map(item => item.str ?? "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    const numChars = text.length;
    pages.push({ pageNumber, text, numChars });
    totalChars += numChars;
    console.log("[extractPdfText] page", pageNumber, "chars=", numChars);
    if (numChars >= MIN_PAGE_CHARS) pagesWithText += 1;
  }

  const fullText = pages
    .map(page => page.text)
    .join("\n\n")
    .trim();

  const needsOcr = shouldFallbackToOcr({ totalChars, pagesWithText, numPages: doc.numPages });

  return {
    pages,
    fullText,
    totalChars,
    pagesWithText,
    numPages: doc.numPages,
    needsOcr,
  };
}

function toPdfJsData (input: Uint8Array | Buffer): Uint8Array {
  if (Buffer.isBuffer(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  return input;
}
