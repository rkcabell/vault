/**
 * Reads the text out of a scanned document by running the ocrmypdf command,
 * turning an image into a one-page PDF first where necessary.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { default as PdfLib } from "pdf-lib";
import { looksLikeHeic } from "../../lib/fileSignatures.js";

let _pdfLib: typeof PdfLib | null = null;
async function getPdfLib() {
  return (_pdfLib ??= await import("pdf-lib"));
}

const MAX_CAPTURE_BYTES = 50 * 1024;

export type OcrmypdfArgs = {
  input: Buffer;
  mimeType?: string | null;
  language?: string | null;
  rotation?: string | number | null;
  onProgress?: (progress: { current: number; total?: number | null }) => void;
  abortSignal?: AbortSignal;
};

export type OcrmypdfResult = {
  ocrPdf: Buffer;
};

/**
 * Returns a copy of `input` with recognized text added to it, as a PDF.
 *
 * An image is converted to a single-page PDF before recognition, because
 * ocrmypdf reads PDFs only. Existing text is replaced rather than added to, so
 * a document that already has some is not left with two copies.
 */
export async function ocrWithOcrmypdf (args: OcrmypdfArgs): Promise<OcrmypdfResult> {
  const workdir = await mkdtemp(join(tmpdir(), "ocrmypdf-"));
  const inputPdfPath = join(workdir, `${randomUUID()}.pdf`);
  const outputPdfPath = join(workdir, `${randomUUID()}-ocr.pdf`);

  try {
    const pdfBuffer = await toPdfBuffer(args.input, args.mimeType, args.rotation);
    await writeFile(inputPdfPath, pdfBuffer);

    const totalPages = await getPdfPageCount(pdfBuffer);
    const supportsProgress = typeof args.onProgress === "function";
    const baseArgs = [
      "--force-ocr",
      "--output-type",
      "pdf",
      "--jobs",
      "4",
      ...(args.language ? ["-l", args.language] : []),
      inputPdfPath,
      outputPdfPath,
    ];
    const cmdArgs = supportsProgress ? ["--progress-bar", ...baseArgs] : ["--quiet", ...baseArgs];

    const runResult = await runOcrmypdf(
      cmdArgs,
      supportsProgress ? args.onProgress : undefined,
      totalPages,
      args.abortSignal,
    );

    if (runResult.code !== 0) {
      const fallback =
        supportsProgress && /progress-bar/i.test(runResult.stderr + runResult.stdout);
      if (fallback) {
        const retryResult = await runOcrmypdf(["--quiet", ...baseArgs], undefined, totalPages, args.abortSignal);
        if (retryResult.code !== 0) {
          throw buildOcrmypdfError(retryResult);
        }
      } else {
        throw buildOcrmypdfError(runResult);
      }
    }

    const ocrPdf = await readFile(outputPdfPath);
    return { ocrPdf };
  } finally {
    try {
      await rm(workdir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
}

// Returns `input` as a PDF, converting it if it is an image.
//
// The leading bytes decide, not `mimeType`: a recorded type is often wrong, and
// sending an image to ocrmypdf as though it were a PDF fails outright.
async function toPdfBuffer (
  input: Buffer,
  mimeType?: string | null,
  rotation?: string | number | null,
): Promise<Buffer> {
  if (looksLikePdf(input)) return input;
  if (mimeType && mimeType.toLowerCase().includes("pdf")) {
    // The recorded type claims PDF but the bytes disagree. Treated as an image.
  }

  const isHeic =
    looksLikeHeic(input) ||
    (!!mimeType && (mimeType.includes("heic") || mimeType.includes("heif")));

  if (isHeic) {
    const { default: convert } = await import("heic-convert");
    const pngBuffer = await convert({ buffer: input, format: "PNG" });
    return imageToPdf(Buffer.from(pngBuffer), rotation);
  }

  return imageToPdf(input, rotation);
}

function looksLikePdf (buf: Buffer): boolean {
  // Matches "%PDF-", one byte more than lib/fileSignatures' own check.
  if (buf.length < 5) return false;
  return (
    buf[0] === 0x25 && // %
    buf[1] === 0x50 && // P
    buf[2] === 0x44 && // D
    buf[3] === 0x46 && // F
    buf[4] === 0x2d // -
  );
}

// Returns how many pages a PDF has, or null when it cannot be read. Only used
// to report progress, so an unreadable file is not an error here.
async function getPdfPageCount (buffer: Buffer): Promise<number | null> {
  try {
    const { PDFDocument } = await getPdfLib();
    const doc = await PDFDocument.load(buffer);
    return doc.getPageCount();
  } catch {
    return null;
  }
}

type OcrmypdfRunResult = {
  code: number;
  stdout: string;
  stderr: string;
};

/**
 * Runs ocrmypdf and returns its exit code with whatever it printed.
 *
 * A non-zero exit is returned rather than raised, so the caller can decide
 * whether to try again differently. Only the last part of the output is kept,
 * so a run that prints a great deal cannot use up memory.
 *
 * Both output streams are also fed to `onProgress`, because ocrmypdf writes its
 * progress to either one.
 */
async function runOcrmypdf (
  cmdArgs: string[],
  onProgress?: (progress: { current: number; total?: number | null }) => void,
  totalPages?: number | null,
  abortSignal?: AbortSignal,
): Promise<OcrmypdfRunResult> {
  const progressParser = createProgressParser(onProgress, totalPages ?? null);
  const child = spawn("ocrmypdf", cmdArgs, { stdio: ["ignore", "pipe", "pipe"], signal: abortSignal });
  let stdout = "";
  let stderr = "";

  const append = (buffer: string, chunk: Buffer) => {
    const next = buffer + chunk.toString("utf8");
    return next.length > MAX_CAPTURE_BYTES ? next.slice(-MAX_CAPTURE_BYTES) : next;
  };

  child.stdout.on("data", chunk => {
    stdout = append(stdout, chunk as Buffer);
    progressParser(chunk as Buffer);
  });
  child.stderr.on("data", chunk => {
    stderr = append(stderr, chunk as Buffer);
    progressParser(chunk as Buffer);
  });

  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", code => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

/**
 * Returns a stateful chunk parser that scans ocrmypdf's output for progress lines.
 *
 * ocrmypdf emits lines like "Page 3/12" or "3/12" when --progress-bar is set.
 * The parser buffers incomplete lines across chunks, deduplicates repeated
 * progress values, and fires `onProgress` only when current or total changes.
 * An initial `{ current: 0, total }` event is emitted immediately if totalPages
 * is known, so callers can show a 0 % state before any output arrives.
 */
function createProgressParser (
  onProgress?: (progress: { current: number; total?: number | null }) => void,
  totalPages?: number | null,
) {
  let buffer = "";
  let lastCurrent = -1;
  let lastTotal = typeof totalPages === "number" ? totalPages : null;

  if (onProgress && lastTotal !== null) {
    onProgress({ current: 0, total: lastTotal });
  }

  return (chunk: Buffer) => {
    if (!onProgress) return;
    buffer += chunk.toString("utf8");
    const parts = buffer.split(/\r?\n|\r/);
    buffer = parts.pop() ?? "";

    for (const line of parts) {
      const match =
        line.match(/page\s*(\d+)\s*(?:\/|of)\s*(\d+)/i) ?? line.match(/(\d+)\s*\/\s*(\d+)/);
      if (!match) continue;

      const current = Number.parseInt(match[1], 10);
      const total = Number.parseInt(match[2], 10);
      if (!Number.isFinite(current) || !Number.isFinite(total)) continue;
      if (current === lastCurrent && total === lastTotal) continue;

      lastCurrent = current;
      lastTotal = total;
      onProgress({ current, total });
    }
  };
}

/** Build a descriptive Error from a non-zero ocrmypdf exit, including captured stderr/stdout. */
function buildOcrmypdfError (result: OcrmypdfRunResult): Error {
  const baseMsg = `ocrmypdf failed (exit ${result.code})`;
  const stderr = result.stderr.trim() ? `stderr: ${result.stderr.trim()}` : null;
  const stdout = result.stdout.trim() ? `stdout: ${result.stdout.trim()}` : null;
  const extra = [stderr, stdout].filter(Boolean).join("\n");
  return new Error(extra ? `${baseMsg}\n${extra}` : baseMsg);
}

// Returns `buffer`, an image, wrapped in a one-page PDF that ocrmypdf can read.
async function imageToPdf (buffer: Buffer, rotation?: string | number | null): Promise<Buffer> {
  const angle = normalizeRotation(rotation);
  const { default: sharp } = await import("sharp");
  const { PDFDocument } = await getPdfLib();

  // Flattened onto white so a transparent image does not come out black, and
  // rotated first so the text is the right way up for recognition.
  const png = await sharp(buffer)
    .rotate(angle)
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .png()
    .toBuffer();

  const pdfDoc = await PDFDocument.create();
  const img = await pdfDoc.embedPng(png);

  // The page is sized in points to match the image in pixels. Recognition works
  // from the pixels, so the physical size on paper does not matter.
  const page = pdfDoc.addPage([img.width, img.height]);
  page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}

/**
 * Parse and normalise a rotation value to a non-negative angle in [0, 360).
 * Accepts numeric degrees or their string representation. Returns 0 for null,
 * undefined, or any value that doesn't parse to a finite number.
 */
function normalizeRotation (value?: string | number | null): number {
  if (value === undefined || value === null) return 0;
  const parsed = typeof value === "string" ? Number.parseInt(value, 10) : value;
  if (!Number.isFinite(parsed)) return 0;
  const normalized = ((parsed % 360) + 360) % 360;
  return normalized;
}
