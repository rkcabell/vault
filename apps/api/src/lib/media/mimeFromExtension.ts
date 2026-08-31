import { extOf } from "./extensions.js";

/**
 * Works out a file's type from its name. In-place indexing finds files on disk,
 * where the browser's `File.type` is not available.
 */

/**
 * The extensions Vault recognises. The set mirrors the one in
 * `lib/tags/mimeTypeTag.ts`, so a file is classified and tagged the same way
 * however it reached the library.
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
 * Returns the MIME type for a filename's extension. An unknown extension, or
 * none at all, gives `application/octet-stream`.
 */
export function mimeFromExtension (filename: string): string {
  return EXT_MIME[extOf(filename)] ?? "application/octet-stream";
}
