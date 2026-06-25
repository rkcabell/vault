import { extOf } from "./extensions.js";

/**
 * Map a file extension to a MIME type. Used by in-place indexing, where files
 * are discovered on disk and the browser's `File.type` is unavailable. The set
 * mirrors the extensions enumerated in `lib/tags/mimeTypeTag.ts` so indexed and
 * uploaded items classify, tag, and OCR identically.
 */
export const EXT_MIME: Record<string, string> = {
  // Images
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  tiff: "image/tiff",
  tif: "image/tiff",
  bmp: "image/bmp",
  heic: "image/heic",
  heif: "image/heif",
  avif: "image/avif",
  // Documents
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  rtf: "application/rtf",
  epub: "application/epub+zip",
  // Text
  txt: "text/plain",
  csv: "text/csv",
  html: "text/html",
  htm: "text/html",
  md: "text/markdown",
  markdown: "text/markdown",
  // Video
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
  // Audio
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  flac: "audio/flac",
  aac: "audio/aac",
  // Archives
  zip: "application/zip",
  tar: "application/x-tar",
  gz: "application/gzip",
  "7z": "application/x-7z-compressed",
  rar: "application/x-rar-compressed",
};

/**
 * Infer a MIME type from a filename's extension, falling back to
 * `application/octet-stream` for unknown/extension-less names.
 */
export function mimeFromExtension (filename: string): string {
  return EXT_MIME[extOf(filename)] ?? "application/octet-stream";
}
