// File: apps/api/src/lib/text/processTextJob.ts
import { extractPdfText, type PdfTextPage } from "@/services/pdf/extractPdfText.js";
import { ocrWithOcrmypdf } from "@/services/ocr/ocrWithOcrmypdf.js";
import { readObjectBuffer } from "../../adapters/storage/getObjectBuffer.js";
import type { StorageAdapter } from "../../adapters/storage/types.js";
import { looksLikeHeic } from "../../lib/fileSignatures.js";

export type TextSource = "NATIVE" | "OCR";
export type TextJobErrorCode = "SOURCE_NOT_READY" | "TIMEOUT";

/**
 * Typed error thrown by processTextJob for known failure conditions.
 * `code` is machine-readable so callers can branch on it without string-matching
 * against error messages (see isTransientError in ocrProcessingService).
 */
export class TextJobError extends Error {
  code: TextJobErrorCode;

  constructor (code: TextJobErrorCode, message?: string) {
    super(message ?? code);
    this.name = "TextJobError";
    this.code = code;
  }
}

export type ProcessTextResult = {
  textSource: TextSource;
  rawText: string;
  pages: PdfTextPage[] | null;
  needsOcr: boolean;
};

export type ProcessTextJobDeps = {
  getObjectBuffer?: typeof readObjectBuffer;
  ocrWithOcrmypdf?: typeof ocrWithOcrmypdf;
  isBlankImage?: (buffer: Buffer) => Promise<boolean>;
  logger?: { info: (ctx: object, msg: string) => void };
};

/**
 * Download a file from S3 and extract its text content.
 *
 * Two paths:
 * - **Native** (`isPdf && !forceOcr`): uses pdf.js to extract embedded text.
 *   Returns `needsOcr: true` when the PDF appears to be a scanned image with
 *   no embedded text layer.
 * - **OCR** (all other cases, or when forceOcr = true): runs ocrmypdf to
 *   produce a text-layer PDF, then extracts text from that with pdf.js.
 *   Non-PDF images are first checked for blankness — near-uniform white
 *   images skip OCR entirely and return empty text.
 *
 * `abortSignal` is forwarded to ocrmypdf's subprocess so the process is
 * killed promptly when the job times out. An AbortError is re-thrown as
 * `TextJobError("TIMEOUT")` for structured handling upstream.
 *
 * `deps` can be overridden in tests to stub S3, ocrmypdf, and blank detection.
 */
export async function processTextJob (
  args: {
    storage: StorageAdapter;
    bucket: string;
    key: string;
    mimeType?: string | null;
    forceOcr?: boolean;
    language?: string | null;
    rotation?: string | null;
    onProgress?: (progress: { current: number; total?: number | null }) => void;
    abortSignal?: AbortSignal;
  },
  deps: ProcessTextJobDeps = {},
): Promise<ProcessTextResult> {
  const { storage, bucket, key, mimeType, forceOcr, language, rotation, onProgress, abortSignal } = args;
  const getBuffer = deps.getObjectBuffer ?? readObjectBuffer;
  const runOcrmypdf = deps.ocrWithOcrmypdf ?? ocrWithOcrmypdf;
  const checkBlankImage = deps.isBlankImage ?? isBlankImage;
  const log = deps.logger;

  const isPdf = mimeType ? mimeType.toLowerCase().includes("pdf") : false;
  const ctx = { key, mimeType, forceOcr: forceOcr ?? false };

  // Native extraction path
  if (isPdf && !forceOcr) {
    log?.info(ctx, "[text] s3 download start");
    const t0 = Date.now();
    const pdfBuffer = await getBuffer(storage, bucket, key);
    log?.info({ ...ctx, bytes: pdfBuffer?.length ?? 0, ms: Date.now() - t0 }, "[text] s3 download done");
    if (!pdfBuffer) throw new TextJobError("SOURCE_NOT_READY", "Source object not ready");

    log?.info(ctx, "[text] pdf.js extract start");
    const t1 = Date.now();
    const extracted = await extractPdfText(pdfBuffer, onProgress ? { onProgress } : undefined);
    log?.info({ ...ctx, chars: extracted.fullText.length, pages: extracted.pages.length, needsOcr: extracted.needsOcr, ms: Date.now() - t1 }, "[text] pdf.js extract done");

    return {
      textSource: "NATIVE",
      rawText: extracted.fullText,
      pages: extracted.pages,
      needsOcr: extracted.needsOcr,
    };
  }

  log?.info(ctx, "[text] s3 download start (ocr path)");
  const t2 = Date.now();
  const sourceBuffer = await getBuffer(storage, bucket, key);
  log?.info({ ...ctx, bytes: sourceBuffer?.length ?? 0, ms: Date.now() - t2 }, "[text] s3 download done (ocr path)");
  if (!sourceBuffer) throw new TextJobError("SOURCE_NOT_READY", "Source object not ready");

  // Blank image shortcut: for non-PDF images, check pixel statistics before
  // spawning tesseract. Near-uniform white images will never produce text.
  if (!isPdf) {
    const blank = await checkBlankImage(sourceBuffer);
    if (blank) {
      log?.info(ctx, "[text] blank image detected, skipping ocr");
      return { textSource: "OCR", rawText: "", pages: null, needsOcr: false };
    }
  }

  // OCR path — pass abortSignal so the subprocess is killed on timeout.
  log?.info(ctx, "[text] ocrmypdf start");
  const t3 = Date.now();
  let ocrPdf: Buffer;
  try {
    ({ ocrPdf } = await runOcrmypdf({
      input: sourceBuffer,
      mimeType,
      language: language ?? undefined,
      rotation: rotation ?? undefined,
      onProgress,
      abortSignal,
    }));
  } catch (err) {
    if (isAbortError(err)) {
      throw new TextJobError("TIMEOUT", "OCR timed out");
    }
    throw err;
  }
  log?.info({ ...ctx, ocrPdfBytes: ocrPdf.length, ms: Date.now() - t3 }, "[text] ocrmypdf done");

  log?.info(ctx, "[text] pdf.js extract start (post-ocr)");
  const t4 = Date.now();
  let extracted;
  try {
    extracted = await extractPdfText(ocrPdf);
  } catch {
    // One retry for OCR text extraction only.
    extracted = await extractPdfText(ocrPdf);
  }
  log?.info({ ...ctx, chars: extracted.fullText.length, ms: Date.now() - t4 }, "[text] pdf.js extract done (post-ocr)");

  return {
    textSource: "OCR",
    rawText: extracted.fullText,
    pages: extracted.pages,
    needsOcr: false,
  };
}

/** Detect both the Web AbortError name and the Node.js ABORT_ERR errno code. */
function isAbortError (err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === "AbortError" || (err as NodeJS.ErrnoException).code === "ABORT_ERR";
}

/**
 * Returns true if the image buffer is near-uniformly white (blank paper/scan).
 * Uses conservative thresholds so documents with even faint text pass through to OCR.
 * Pre-converts HEIC to PNG since sharp lacks libheif support.
 */
async function isBlankImage (buffer: Buffer): Promise<boolean> {
  try {
    const sharp = (await import("sharp")).default;
    let input = buffer;

    if (looksLikeHeic(buffer)) {
      const { default: convert } = await import("heic-convert");
      input = Buffer.from(await convert({ buffer, format: "PNG" }));
    }

    const stats = await sharp(input).stats();
    return stats.channels.every(ch => ch.mean > 248 && ch.stdev < 15);
  } catch {
    return false;
  }
}
