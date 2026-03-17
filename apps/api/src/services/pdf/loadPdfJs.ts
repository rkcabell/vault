// File: apps/api/src/services/pdf/loadPdfJs.ts
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import type * as PdfJs from "pdfjs-dist/legacy/build/pdf.mjs";

let pdfjsPromise: Promise<typeof PdfJs> | null = null;
let resolvedStandardFontDataUrl: string | null | undefined = undefined;

function tryResolveWorkerSrc (): string | null {
  const require = createRequire(import.meta.url);

  const candidates = [
    "pdfjs-dist/legacy/build/pdf.worker.mjs",
    "pdfjs-dist/legacy/build/pdf.worker.min.mjs",
    "pdfjs-dist/build/pdf.worker.mjs",
    "pdfjs-dist/build/pdf.worker.min.mjs",
  ];

  for (const spec of candidates) {
    try {
      const resolved = require.resolve(spec);
      return pathToFileURL(resolved).toString();
    } catch {
      // keep trying
    }
  }

  return null;
}

function tryResolveStandardFontDataUrl (): string | null {
  const require = createRequire(import.meta.url);
  try {
    // Resolve any file inside standard_fonts to get the directory path.
    const marker = require.resolve("pdfjs-dist/standard_fonts/FoxitFixed.pfb");
    return pathToFileURL(dirname(marker)).toString() + "/";
  } catch {
    return null;
  }
}

export function getStandardFontDataUrl (): string | null {
  if (resolvedStandardFontDataUrl === undefined) {
    resolvedStandardFontDataUrl = tryResolveStandardFontDataUrl();
  }
  return resolvedStandardFontDataUrl;
}

export async function loadPdfJs (): Promise<typeof PdfJs> {
  if (!pdfjsPromise) {
    pdfjsPromise = import("pdfjs-dist/legacy/build/pdf.mjs");
  }

  const pdfjs = await pdfjsPromise;

  // pdfjs-dist exposes GlobalWorkerOptions; ensure workerSrc is set once.
  const gwo = pdfjs.GlobalWorkerOptions;
  if (gwo && !gwo.workerSrc) {
    const workerSrc = tryResolveWorkerSrc();
    if (workerSrc) {
      gwo.workerSrc = workerSrc;
    }
  }

  return pdfjs;
}
