/**
 * Works out the short format name shown as an item's `type:` tag, such as
 * "pdf" or "jpg".
 */
import { extOf } from "../media/extensions.js";

// The tag label for each recorded type. Types absent here fall back to the
// filename extension.
const MIME_LABELS: Record<string, string> = {
  // Images
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/tiff": "tiff",
  "image/bmp": "bmp",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/avif": "avif",
  // Documents
  "application/pdf": "pdf",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/rtf": "rtf",
  "application/epub+zip": "epub",
  // Text
  "text/plain": "txt",
  "text/csv": "csv",
  "text/html": "html",
  "text/markdown": "markdown",
  // Video
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "video/x-matroska": "mkv",
  "video/x-msvideo": "avi",
  // Audio
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/ogg": "ogg",
  "audio/flac": "flac",
  "audio/aac": "aac",
  // Archives
  "application/zip": "zip",
  "application/x-tar": "tar",
  "application/gzip": "gz",
  "application/x-7z-compressed": "7z",
  "application/x-rar-compressed": "rar",
};

// The tag label for each filename extension, used when the recorded type is
// missing or too vague. Several extensions share one label, so .jpeg and .tif
// do not create tags separate from .jpg and .tiff.
const EXT_LABELS: Record<string, string> = {
  heic: "heic",
  heif: "heif",
  jpg: "jpg",
  jpeg: "jpg",
  png: "png",
  gif: "gif",
  webp: "webp",
  svg: "svg",
  tiff: "tiff",
  tif: "tiff",
  bmp: "bmp",
  avif: "avif",
  pdf: "pdf",
  doc: "doc",
  docx: "docx",
  xls: "xls",
  xlsx: "xlsx",
  ppt: "ppt",
  pptx: "pptx",
  rtf: "rtf",
  epub: "epub",
  txt: "txt",
  csv: "csv",
  mp4: "mp4",
  mov: "mov",
  mkv: "mkv",
  avi: "avi",
  mp3: "mp3",
  wav: "wav",
  ogg: "ogg",
  flac: "flac",
  aac: "aac",
  zip: "zip",
  tar: "tar",
  gz: "gz",
  "7z": "7z",
  rar: "rar",
};

// Types a browser reports as generic that the extension can identify exactly.
const EXT_MIME_OVERRIDES: Record<string, string> = {
  heic: "image/heic",
  heif: "image/heif",
};

/**
 * Returns the type to record for a file, correcting a browser that reported a
 * generic one where the extension identifies the format.
 */
export function normalizeMimeType(mimeType: string | undefined | null, filename?: string): string {
  const lower = mimeType?.trim().toLowerCase() ?? "";
  if (!lower || lower === "application/octet-stream") {
    const ext = filename ? extOf(filename) : "";
    if (EXT_MIME_OVERRIDES[ext]) return EXT_MIME_OVERRIDES[ext];
  }
  return mimeType?.trim() ?? "application/octet-stream";
}

/**
 * Returns the format label for an item's `type:` tag.
 *
 * The recorded type is preferred, then the filename extension. An unrecognized
 * extension becomes the tag itself with characters that tags disallow removed,
 * and a file with neither is tagged "unknown".
 */
export function buildMimeTypeTag(mimeType: string | undefined | null, filename?: string): string {
  // A name with no extension, such as "(adobe)", yields "" here and ends up
  // tagged "unknown".
  const ext = filename ? extOf(filename) : "";

  const lower = mimeType?.trim().toLowerCase() ?? "";
  if (lower && lower !== "application/octet-stream" && MIME_LABELS[lower]) {
    return MIME_LABELS[lower];
  }

  if (ext) {
    if (EXT_LABELS[ext]) return EXT_LABELS[ext];
    // Characters outside the tag alphabet are dropped rather than rejected, so
    // an extension like ".(adobe)" cannot fail tag validation later.
    const sanitized = ext.replace(/[^a-z0-9-]/g, "");
    return sanitized || "unknown";
  }

  return "unknown";
}
