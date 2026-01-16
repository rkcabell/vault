import { createCanvas, Path2D, DOMMatrix, ImageData } from "@napi-rs/canvas";
import { loadPdfJs } from "../pdf/loadPdfJs.js";

function toPdfJsData (input: Uint8Array | Buffer): Uint8Array {
  if (Buffer.isBuffer(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  return input;
}

function ensureCanvasGlobals () {
  const g = globalThis as any;
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

  const loadingTask = pdfjs.getDocument({
    data,
    disableWorker: true,
  });

  const doc = await loadingTask.promise;

  try {
    const page = await doc.getPage(1);

    // Start from scale=1 viewport to compute scale for targetWidth
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
      canvasContext: ctx as any,
      viewport,
    });

    await renderTask.promise;

    // napi-rs canvas returns a PNG buffer directly
    return canvas.toBuffer("image/png");
  } finally {
    try {
      await doc.destroy();
    } catch {
      // ignore
    }
  }
}
