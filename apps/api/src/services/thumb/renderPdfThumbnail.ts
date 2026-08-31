/**
 * Draws the first page of a PDF as an image, to use as its thumbnail.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Path2D, DOMMatrix, ImageData } from "@napi-rs/canvas";
import type * as Canvas from "@napi-rs/canvas";
import { loadPdfJs, getStandardFontDataUrl } from "../pdf/loadPdfJs.js";

let _canvas: typeof Canvas | null = null;
async function getCanvas() {
  return (_canvas ??= await import("@napi-rs/canvas"));
}
import type { DocumentInitParameters } from "pdfjs-dist/types/src/display/api";

function toPdfJsData (input: Uint8Array | Buffer): Uint8Array {
  // The bytes are copied first. The PDF library may take ownership of the
  // buffer it is handed, and a Node buffer is a window onto memory shared with
  // other buffers, which would then be unusable.
  return new Uint8Array(input);
}

// The drawing types the PDF library expects a browser to provide.
type CanvasGlobals = {
  Path2D?: typeof Path2D;
  DOMMatrix?: typeof DOMMatrix;
  ImageData?: typeof ImageData;
};

// Puts the drawing types on the global object, since the PDF library looks for
// them there rather than accepting them as arguments.
async function ensureCanvasGlobals () {
  const { Path2D, DOMMatrix, ImageData } = await getCanvas();
  const g = globalThis as typeof globalThis & CanvasGlobals;
  if (!g.Path2D) g.Path2D = Path2D;
  if (!g.DOMMatrix) g.DOMMatrix = DOMMatrix;
  if (!g.ImageData) g.ImageData = ImageData;
}

/**
 * Returns the first page of `pdf` drawn as a PNG.
 *
 * The page is drawn at `targetWidth` unless that would make an image larger
 * than `maxPixels`, in which case it is drawn smaller. A page with
 * transparency is drawn onto white, so a scanned page does not come out black.
 */
export async function renderPdfThumbnail (args: {
  pdf: Uint8Array | Buffer;
  targetWidth?: number;
  maxWidth?: number;
  maxPixels?: number;
}): Promise<Buffer> {
  const { pdf, targetWidth = 1200, maxWidth = 2000, maxPixels = 10_000_000 } = args;

  await ensureCanvasGlobals();

  const pdfjs = await loadPdfJs();
  const data = toPdfJsData(pdf);

  const init: DocumentInitParameters & { disableWorker?: boolean } = {
    data,
    // Drawing happens in this process rather than a background worker, because
    // the thumbnail worker is already a process of its own.
    disableWorker: true,
    StandardFontDataFactory: class {
      private baseUrl: string;
      constructor({ baseUrl }: { baseUrl?: string | null }) {
        this.baseUrl = baseUrl ?? "";
      }
      fetch({ filename }: { filename: string }): Promise<Uint8Array> {
        return readFile(fileURLToPath(this.baseUrl + filename));
      }
    },
    standardFontDataUrl: getStandardFontDataUrl() ?? undefined,
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

    const { createCanvas } = await getCanvas();
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
