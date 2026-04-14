import type { TextSource } from "./types";
import type { MediaWorkerState } from "@vault/types";

export function describeInboxStatus(thumbState: MediaWorkerState, textState: MediaWorkerState): string {
  const thumbFailed = thumbState === "ERROR" || thumbState === "FAILED";
  const textFailed  = textState  === "ERROR" || textState  === "FAILED";
  const thumbPending = thumbState === "PENDING";
  const textPending  = textState  === "PENDING";

  if (thumbFailed && textFailed) return "Thumbnail + text extraction failed";
  if (thumbFailed) return "Thumbnail generation failed";
  if (textFailed)  return "Text extraction failed";
  if (thumbPending && textPending) return "Processing…";
  if (thumbPending) return "Generating thumbnail…";
  if (textPending)  return "Extracting text…";
  return "Processing…";
}

export const ARCHIVE_MIME_TYPES = new Set([
  "application/zip",
  "application/x-zip-compressed",
  "application/x-tar",
  "application/gzip",
  "application/x-gzip",
  "application/x-7z-compressed",
  "application/x-rar-compressed",
  "application/vnd.rar",
]);

export function formatBytes(value?: number | null) {
  if (value === null || value === undefined || Number.isNaN(value)) return "N/A";
  if (value === 0) return "0 B";

  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  const formatted = size >= 10 || unitIndex === 0 ? size.toFixed(0) : size.toFixed(1);
  return `${formatted} ${units[unitIndex]}`;
}

export async function readErrorMessage(response: Response, fallback: string) {
  try {
    const data = await response.json();
    if (data?.error || data?.message) return data.error || data.message;
  } catch {
    // ignore
  }
  return `${fallback} (${response.status})`;
}

export function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeTextSource(value?: string | null): TextSource {
  if (value === "OCR") return "OCR";
  if (value === "NATIVE") return "NATIVE";
  return "UNKNOWN";
}

export function parseSearchTerms(value: string) {
  const terms = value
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 0);

  const unique: string[] = [];
  for (const term of terms) {
    if (!unique.includes(term)) unique.push(term);
    if (unique.length >= 6) break;
  }

  return unique;
}

const MIME_TAGS: Record<string, string> = {
  // Images
  "image/jpeg": "JPEG",
  "image/jpg": "JPEG",
  "image/png": "PNG",
  "image/gif": "GIF",
  "image/webp": "WebP",
  "image/svg+xml": "SVG",
  "image/tiff": "TIFF",
  "image/bmp": "BMP",
  "image/heic": "HEIC",
  "image/heif": "HEIF",
  "image/avif": "AVIF",
  // Documents
  "application/pdf": "PDF",
  "application/msword": "DOC",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "DOCX",
  "application/vnd.ms-excel": "XLS",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "XLSX",
  "application/vnd.ms-powerpoint": "PPT",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "PPTX",
  "application/rtf": "RTF",
  // Text
  "text/plain": "TXT",
  "text/csv": "CSV",
  "text/html": "HTML",
  "text/markdown": "Markdown",
  // Video
  "video/mp4": "MP4",
  "video/webm": "WebM",
  "video/quicktime": "MOV",
  "video/x-matroska": "MKV",
  "video/x-msvideo": "AVI",
  // Audio
  "audio/mpeg": "MP3",
  "audio/wav": "WAV",
  "audio/ogg": "OGG",
  "audio/flac": "FLAC",
  "audio/aac": "AAC",
  // Archives
  "application/zip": "ZIP",
  "application/x-tar": "TAR",
  "application/gzip": "GZ",
  "application/x-7z-compressed": "7Z",
  "application/x-rar-compressed": "RAR",
};

const EXT_TAGS: Record<string, string> = {
  ".heic": "HEIC",
  ".heif": "HEIF",
  ".avif": "AVIF",
  ".webp": "WebP",
  ".jpg": "JPEG",
  ".jpeg": "JPEG",
  ".png": "PNG",
  ".gif": "GIF",
  ".tiff": "TIFF",
  ".tif": "TIFF",
  ".bmp": "BMP",
  ".svg": "SVG",
  ".pdf": "PDF",
  ".doc": "DOC",
  ".docx": "DOCX",
  ".xls": "XLS",
  ".xlsx": "XLSX",
  ".ppt": "PPT",
  ".pptx": "PPTX",
  ".rtf": "RTF",
  ".txt": "TXT",
  ".csv": "CSV",
  ".mp4": "MP4",
  ".mov": "MOV",
  ".mkv": "MKV",
  ".avi": "AVI",
  ".webm": "WebM",
  ".mp3": "MP3",
  ".wav": "WAV",
  ".flac": "FLAC",
  ".aac": "AAC",
  ".ogg": "OGG",
  ".zip": "ZIP",
  ".tar": "TAR",
  ".gz": "GZ",
  ".7z": "7Z",
  ".rar": "RAR",
};

/**
 * Returns a short human-readable label for a MIME type (e.g. "HEIC", "PDF").
 * Accepts an optional filename to use as a fallback when the MIME type is
 * uninformative (e.g. application/octet-stream for HEIC files from browsers).
 */
export function formatMimeTag(mimeType?: string | null, filename?: string | null): string {
  const lower = mimeType?.toLowerCase().trim() ?? "";

  if (lower && lower !== "application/octet-stream") {
    if (MIME_TAGS[lower]) return MIME_TAGS[lower];
  }

  // Filename extension before raw subtype extraction — gives "DLL" not "MSDOWNLOAD"
  if (filename) {
    const dot = filename.lastIndexOf(".");
    if (dot !== -1) {
      const ext = filename.slice(dot).toLowerCase();
      if (EXT_TAGS[ext]) return EXT_TAGS[ext];
      return ext.slice(1).toUpperCase();
    }
  }

  // Last resort: raw subtype extraction
  if (lower && lower !== "application/octet-stream") {
    const subtype = lower.split("/")[1];
    if (subtype) return subtype.replace(/^(x-|vnd\.)/, "").toUpperCase();
  }

  return "File";
}

export function containsAnyTerm(text: string, terms: string[]) {
  const lower = text.toLowerCase();
  return terms.some((term) => lower.includes(term.toLowerCase()));
}
