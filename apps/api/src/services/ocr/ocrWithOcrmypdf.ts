// File: apps/api/src/services/ocr/ocrWithOcrmypdf.ts
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";

const execFileAsync = promisify(execFile);

export type OcrmypdfArgs = {
  input: Buffer;
  mimeType?: string | null;
  language?: string | null;
  rotation?: string | number | null;
};

export type OcrmypdfResult = {
  ocrPdf: Buffer;
};

/**
 * Run OCRmyPDF against a PDF or image buffer and return the OCR'd PDF buffer.
 * For images, normalize to a bitmap (PNG) then wrap in a one-page PDF first.
 */
export async function ocrWithOcrmypdf (args: OcrmypdfArgs): Promise<OcrmypdfResult> {
  const workdir = await mkdtemp(join(tmpdir(), "ocrmypdf-"));
  const inputPdfPath = join(workdir, `${randomUUID()}.pdf`);
  const outputPdfPath = join(workdir, `${randomUUID()}-ocr.pdf`);

  try {
    const pdfBuffer = await toPdfBuffer(args.input, args.mimeType, args.rotation);
    await writeFile(inputPdfPath, pdfBuffer);

    const cmdArgs = [
      "--skip-text",
      "--output-type",
      "pdf",
      "--quiet",
      "--jobs",
      "4",
      ...(args.language ? ["-l", args.language] : []),
      inputPdfPath,
      outputPdfPath,
    ];

    // Note: ocrmypdf can produce lots of output; maxBuffer protects Node.
    await execFileAsync("ocrmypdf", cmdArgs, {
      maxBuffer: 50 * 1024 * 1024,
    });

    const ocrPdf = await readFile(outputPdfPath);
    return { ocrPdf };
  } catch (err) {
    // Capture stderr when execFile fails (very useful for diagnosing ocrmypdf).
    const e = err as any;
    const baseMsg = err instanceof Error ? err.message : String(err);
    const stderr = typeof e?.stderr === "string" && e.stderr.trim() ? e.stderr.trim() : null;
    const stdout = typeof e?.stdout === "string" && e.stdout.trim() ? e.stdout.trim() : null;

    const extra = [stderr ? `stderr: ${stderr}` : null, stdout ? `stdout: ${stdout}` : null]
      .filter(Boolean)
      .join("\n");

    throw new Error(
      extra ? `ocrmypdf failed: ${baseMsg}\n${extra}` : `ocrmypdf failed: ${baseMsg}`,
    );
  } finally {
    try {
      await rm(workdir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
}

/**
 * Prefer sniffing bytes over trusting mimeType, since object stores often lie.
 */
async function toPdfBuffer (
  input: Buffer,
  mimeType?: string | null,
  rotation?: string | number | null,
): Promise<Buffer> {
  if (looksLikePdf(input)) return input;
  if (mimeType && mimeType.toLowerCase().includes("pdf")) {
    // MIME says pdf but bytes don't; treat as image anyway to avoid misrouting.
    // (You can log this mismatch at the call-site if desired.)
  }
  return imageToPdf(input, rotation);
}

function looksLikePdf (buf: Buffer): boolean {
  // "%PDF-" at start
  if (buf.length < 5) return false;
  return (
    buf[0] === 0x25 && // %
    buf[1] === 0x50 && // P
    buf[2] === 0x44 && // D
    buf[3] === 0x46 && // F
    buf[4] === 0x2d // -
  );
}

async function imageToPdf (buffer: Buffer, rotation?: string | number | null): Promise<Buffer> {
  const angle = normalizeRotation(rotation);

  // 1) Normalize to PNG with white background (Sharp supports this reliably)
  const png = await sharp(buffer)
    .rotate(angle)
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .png()
    .toBuffer();

  // 2) Wrap in a single-page PDF (pdf-lib)
  const pdfDoc = await PDFDocument.create();
  const img = await pdfDoc.embedPng(png);

  // Page size equals image pixel size in PDF points; acceptable for OCR.
  // If you want DPI-aware sizing, scale here.
  const page = pdfDoc.addPage([img.width, img.height]);
  page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}

function normalizeRotation (value?: string | number | null): number {
  if (value === undefined || value === null) return 0;
  const parsed = typeof value === "string" ? Number.parseInt(value, 10) : value;
  if (!Number.isFinite(parsed)) return 0;
  const normalized = ((parsed % 360) + 360) % 360;
  return normalized;
}
