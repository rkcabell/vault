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

const EXT_MIME_OVERRIDES: Record<string, string> = {
  heic: "image/heic",
  heif: "image/heif",
};

/**
 * Corrects a browser-reported MIME type using the file extension when the
 * browser supplies a generic type (e.g. application/octet-stream for HEIC).
 */
export function normalizeMimeType(mimeType: string | undefined | null, filename?: string): string {
  const lower = mimeType?.trim().toLowerCase() ?? "";
  if (!lower || lower === "application/octet-stream") {
    const ext = filename?.split(".").pop()?.toLowerCase() ?? "";
    if (EXT_MIME_OVERRIDES[ext]) return EXT_MIME_OVERRIDES[ext];
  }
  return mimeType?.trim() ?? "application/octet-stream";
}

export function buildMimeTypeTag(mimeType: string | undefined | null, filename?: string): string {
  const ext = filename?.split(".").pop()?.toLowerCase() ?? "";

  // Look up by MIME type first
  const lower = mimeType?.trim().toLowerCase() ?? "";
  if (lower && lower !== "application/octet-stream" && MIME_LABELS[lower]) {
    return MIME_LABELS[lower];
  }

  // Fall back to file extension
  if (ext && EXT_LABELS[ext]) {
    return EXT_LABELS[ext];
  }

  // Last resort: return unknown
  return "unknown";
}
