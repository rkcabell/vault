import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

let pdfjsPromise: Promise<any> | null = null;

export async function loadPdfJs () {
  if (!pdfjsPromise) {
    pdfjsPromise = import("pdfjs-dist/legacy/build/pdf.mjs");
  }

  const mod = await pdfjsPromise;
  const pdfjs = (mod as { default?: unknown }).default ?? mod;

  const gwo = (pdfjs as { GlobalWorkerOptions?: { workerSrc?: string } }).GlobalWorkerOptions;
  if (gwo && !gwo.workerSrc) {
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
        gwo.workerSrc = pathToFileURL(resolved).toString();
        break;
      } catch {
        // keep trying
      }
    }
  }

  return pdfjs;
}
