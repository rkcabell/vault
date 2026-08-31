import { extractPdfText, type PdfTextPage } from "@/services/pdf/extractPdfText.js";
import { ocrWithOcrmypdf } from "@/services/ocr/ocrWithOcrmypdf.js";
import { readObjectBuffer } from "../../adapters/storage/getObjectBuffer.js";
import { readSourceBuffer } from "../../adapters/storage/openSource.js";
import type { StorageAdapter } from "../../adapters/storage/types.js";
import { looksLikeHeic } from "../../lib/fileSignatures.js";
import { isPlainTextMime, MAX_TEXT_CHARS } from "../media/processingSupport.js";

/**
 * Gets a file's text out of it, by whichever route its type calls for: a direct
 * read, pdf.js, or ocrmypdf.
 */

export type TextSource = "NATIVE" | "OCR";
export type TextJobErrorCode = "SOURCE_NOT_READY" | "TIMEOUT";

/**
 * Signals a failure this module recognises. `code` is machine-readable, so a
 * caller can branch on it rather than matching against the message text.
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
 * Reads a file, from managed storage or from the user's own drive, and returns
 * the text in it.
 *
 * Plain text is decoded directly, and takes that route even when `forceOcr` is
 * set. A PDF with no text layer comes back with `needsOcr: true`. Everything
 * else goes to ocrmypdf, except an image, which is checked for blankness first
 * so a near-white scan skips OCR.
 *
 * `abortSignal` reaches ocrmypdf's subprocess, so a timeout kills it promptly.
 * The resulting AbortError is re-thrown as `TextJobError("TIMEOUT")`.
 */
export async function processTextJob (
  args: {
    storage: StorageAdapter;
    bucket: string;
    /** Null for in-place indexed items — see the media_source_xor constraint. */
    key: string | null;
    mimeType?: string | null;
    forceOcr?: boolean;
    language?: string | null;
    rotation?: string | null;
    onProgress?: (progress: { current: number; total?: number | null }) => void;
    abortSignal?: AbortSignal;
    /** Absolute path on the user's own drive when the item is indexed in place. */
    sourcePath?: string | null;
    /** Configured allow-list, required to read an in-place source. */
    allowedRoots?: string[];
  },
  deps: ProcessTextJobDeps = {},
): Promise<ProcessTextResult> {
  const { storage, bucket, key, mimeType, forceOcr, language, rotation, onProgress, abortSignal, sourcePath } = args;
  const allowedRoots = args.allowedRoots ?? [];
  const getBuffer = deps.getObjectBuffer ?? readObjectBuffer;
  const runOcrmypdf = deps.ocrWithOcrmypdf ?? ocrWithOcrmypdf;
  const checkBlankImage = deps.isBlankImage ?? isBlankImage;
  const log = deps.logger;

  // An item indexed in place is read from disk, read-only. A managed one goes
  // through the storage adapter, which a test can replace.
  const loadSource = (): Promise<Buffer | null> => {
    if (sourcePath) return readSourceBuffer({ storage, bucket, storageKey: key, sourcePath, allowedRoots });
    // media_source_xor guarantees key is set whenever sourcePath isn't.
    if (!key) throw new TextJobError("SOURCE_NOT_READY", "Media row has neither sourcePath nor storageKey");
    return getBuffer(storage, bucket, key);
  };

  const isPdf = mimeType ? mimeType.toLowerCase().includes("pdf") : false;
  const ctx = { key, mimeType, forceOcr: forceOcr ?? false };

  // A text/* file is already text, so it is read and decoded directly. Checked
  // first, so it takes this route even when forceOcr is set. What is stored is
  // capped; the caller has already skipped anything over MAX_TEXT_BYTES.
  if (isPlainTextMime(mimeType ?? "")) {
    log?.info(ctx, "[text] plain-text read start");
    const buf = await loadSource();
    if (!buf) throw new TextJobError("SOURCE_NOT_READY", "Source object not ready");
    const rawText = decodeUtf8(buf).slice(0, MAX_TEXT_CHARS);
    log?.info({ ...ctx, chars: rawText.length }, "[text] plain-text read done");
    return { textSource: "NATIVE", rawText, pages: null, needsOcr: false };
  }

  if (isPdf && !forceOcr) {
    log?.info(ctx, "[text] source read start");
    const t0 = Date.now();
    const pdfBuffer = await loadSource();
    log?.info({ ...ctx, bytes: pdfBuffer?.length ?? 0, ms: Date.now() - t0 }, "[text] source read done");
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

  log?.info(ctx, "[text] source read start (ocr path)");
  const t2 = Date.now();
  const sourceBuffer = await loadSource();
  log?.info({ ...ctx, bytes: sourceBuffer?.length ?? 0, ms: Date.now() - t2 }, "[text] source read done (ocr path)");
  if (!sourceBuffer) throw new TextJobError("SOURCE_NOT_READY", "Source object not ready");

  // An image's pixel statistics are cheap next to spawning Tesseract, and a
  // near-uniformly white one will never produce text.
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
    // One retry, which covers a transient pdf.js worker-init race. A failure
    // that is not transient throws again.
    // TODO: gate this on a signal that the failure was transient.
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

// Decodes a buffer as UTF-8, dropping a leading byte-order mark.
function decodeUtf8 (buf: Buffer): string {
  const text = buf.toString("utf8");
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// An abort surfaces as the Web AbortError name or the Node ABORT_ERR code.
function isAbortError (err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === "AbortError" || (err as NodeJS.ErrnoException).code === "ABORT_ERR";
}

/**
 * True when the image is near-uniformly white, as blank paper scans. The
 * thresholds are cautious, so a document with even faint text still reaches OCR.
 * HEIC is converted to PNG first, because sharp cannot read it.
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
