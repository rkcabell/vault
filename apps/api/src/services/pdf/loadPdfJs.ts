/**
 * Loads the PDF reading library once per process and points it at the files it
 * needs from disk.
 */
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import type * as PdfJs from "pdfjs-dist/legacy/build/pdf.mjs";

let pdfjsPromise: Promise<typeof PdfJs> | null = null;
let resolvedStandardFontDataUrl: string | null | undefined = undefined;

// Finds the PDF library's background worker script. Its location differs
// between packaged builds, so each known place is tried in turn.
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

// Finds the folder of fonts the PDF library falls back to for a document that
// does not carry its own.
function tryResolveStandardFontDataUrl (): string | null {
  const require = createRequire(import.meta.url);
  try {
    // A known file inside the folder is resolved, because the folder itself
    // cannot be.
    const marker = require.resolve("pdfjs-dist/standard_fonts/FoxitFixed.pfb");
    return pathToFileURL(dirname(marker)).toString() + "/";
  } catch {
    return null;
  }
}

/** Returns the fallback font folder, or null when the fonts are not installed. Looked up once and remembered. */
export function getStandardFontDataUrl (): string | null {
  if (resolvedStandardFontDataUrl === undefined) {
    resolvedStandardFontDataUrl = tryResolveStandardFontDataUrl();
  }
  return resolvedStandardFontDataUrl;
}

/**
 * Returns the PDF reading library, loading it on first use.
 *
 * The background worker is pointed at its script the first time this runs. A
 * build with no worker script is left alone, and the library then reads
 * documents on the main thread.
 */
export async function loadPdfJs (): Promise<typeof PdfJs> {
  if (!pdfjsPromise) {
    pdfjsPromise = import("pdfjs-dist/legacy/build/pdf.mjs");
  }

  const pdfjs = await pdfjsPromise;

  const gwo = pdfjs.GlobalWorkerOptions;
  if (gwo && !gwo.workerSrc) {
    const workerSrc = tryResolveWorkerSrc();
    if (workerSrc) {
      gwo.workerSrc = workerSrc;
    }
  }

  return pdfjs;
}
