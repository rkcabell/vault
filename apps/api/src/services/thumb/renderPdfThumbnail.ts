// File: apps/api/src/services/thumbnails/renderPdfThumbnail.ts
import { createCanvas, Path2D, DOMMatrix, ImageData } from "@napi-rs/canvas";
import { loadPdfJs } from "../pdf/loadPdfJs.js";
import type { DocumentInitParameters } from "pdfjs-dist/types/src/display/api";

function toPdfJsData (input: Uint8Array | Buffer): Uint8Array {
  // Copy into a fresh ArrayBuffer — pdf.js may transfer (detach) the buffer it
  // receives, so a view into Node.js's shared pool would cause
  // "Unable to deserialize cloned data" on subsequent access.
  return new Uint8Array(input);
}

type CanvasGlobals = {
  Path2D?: typeof Path2D;
  DOMMatrix?: typeof DOMMatrix;
  ImageData?: typeof ImageData;
};

function ensureCanvasGlobals () {
  const g = globalThis as typeof globalThis & CanvasGlobals;
  if (!g.Path2D) g.Path2D = Path2D;
  if (!g.DOMMatrix) g.DOMMatrix = DOMMatrix;
  if (!g.ImageData) g.ImageData = ImageData;
}

export async function renderPdfThumbnail (args: {
  pdf: Uint8Array | Buffer;
  targetWidth?: number;
  maxWidth?: number;
  maxPixels?: number;
}): Promise<Buffer> {
  const { pdf, targetWidth = 1200, maxWidth = 2000, maxPixels = 10_000_000 } = args;

  ensureCanvasGlobals();

  const pdfjs = await loadPdfJs();
  const data = toPdfJsData(pdf);

  const init: DocumentInitParameters & { disableWorker?: boolean } = {
    data,
    disableWorker: true,
  };

  const loadingTask = pdfjs.getDocument(init);
  const doc = await loadingTask.promise;

  try {
    const page = await doc.getPage(1);

    const viewport1 = page.getViewport({ scale: 1 });
    const desiredWidth = Math.min(targetWidth, maxWidth);
    const scaleByWidth = desiredWidth / viewport1.width;

    const baseArea = viewport1.width * viewport1.height;
    const scaleByArea = Math.sqrt(maxPixels / baseArea);

    const scale = Math.min(scaleByWidth, scaleByArea);

    const viewport = page.getViewport({ scale });
    const width = Math.max(1, Math.floor(viewport.width));
    const height = Math.max(1, Math.floor(viewport.height));

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");

    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const renderTask = page.render({
      canvasContext: ctx as unknown,
      viewport,
    });

    await renderTask.promise;

    return canvas.toBuffer("image/png");
  } finally {
    try {
      await doc.destroy();
    } catch {
      // ignore
    }
  }
}
