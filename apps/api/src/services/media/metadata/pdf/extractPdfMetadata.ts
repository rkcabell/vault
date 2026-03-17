import { loadPdfJs } from "../../../pdf/loadPdfJs.js";
import type { PdfMetadata } from "../types.js";
import type { DocumentInitParameters } from "pdfjs-dist/types/src/display/api";

const MAX_PDF_PAGES = 2000;

export async function extractPdfMetadata(buffer: Buffer): Promise<PdfMetadata | null> {
  try {
    const pdfjs = await loadPdfJs();
    const data = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);

    const init: DocumentInitParameters & { disableWorker?: boolean } = {
      data,
      disableWorker: true,
    };

    const loadingTask = pdfjs.getDocument(init);
    const doc = await loadingTask.promise;

    try {
      const pageCount = doc.numPages ?? null;
      if (typeof pageCount === "number" && pageCount > MAX_PDF_PAGES) {
        return { pageCount };
      }

      const meta = await doc.getMetadata();
      const info = (meta?.info ?? {}) as Record<string, unknown>;

      return {
        title: normalizeString(info["Title"]),
        author: normalizeString(info["Author"]),
        subject: normalizeString(info["Subject"]),
        producer: normalizeString(info["Producer"]),
        creator: normalizeString(info["Creator"]),
        pdfVersion: normalizeString(info["PDFFormatVersion"]),
        pageCount,
        encrypted: parseBoolean(info["IsEncrypted"]),
        createdAt: parsePdfDate(normalizeString(info["CreationDate"])),
        modifiedAt: parsePdfDate(normalizeString(info["ModDate"])),
      };
    } finally {
      try {
        await doc.destroy();
      } catch (err) {
        void err;
      }
    }
  } catch {
    return null;
  }
}

function normalizeString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function parseBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return null;
}

function parsePdfDate(value?: string | null): string | null {
  if (!value) return null;
  const match = value.match(/^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/);
  if (!match) return value;
  const [, year, month, day, hour, minute, second] = match;
  const y = year ?? "0000";
  const mo = month ?? "01";
  const d = day ?? "01";
  const h = hour ?? "00";
  const m = minute ?? "00";
  const s = second ?? "00";
  return `${y}-${mo}-${d} ${h}:${m}:${s}`;
}
