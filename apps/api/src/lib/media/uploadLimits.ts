const MB = 1024 * 1024;
const GB = 1024 * MB;

// One 2 GB cap for every kind — matches the web client (lib/media/uploadLimits.ts),
// the upload page's "2 GB max per file" text, and the big-file storage path
// (Range streaming, Float sizeBytes, 2 GiB thumbnail cap). These MUST stay in
// sync with the client: a lower server cap rejects a file the client accepted,
// which fails the whole batch-init and stamps that error onto every queued file.
export const PHOTO_UPLOAD_LIMIT_BYTES = 2 * GB;
export const DOCUMENT_UPLOAD_LIMIT_BYTES = 2 * GB;
export const HARD_UPLOAD_LIMIT_BYTES = 2 * GB;

const DOCUMENT_MIME_PREFIXES = [
  "application/pdf",
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument",
  "application/vnd.oasis.opendocument",
  "text/",
];

const DOCUMENT_MIME_TYPES = new Set([
  "application/pdf",
  "application/msword",
  "application/rtf",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/epub+zip",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.presentation",
  "application/json",
  "text/csv",
  "text/plain",
]);

const DOCUMENT_EXTENSIONS = new Set([
  ".csv",
  ".doc",
  ".docx",
  ".epub",
  ".pdf",
  ".ppt",
  ".pptx",
  ".rtf",
  ".txt",
  ".xls",
  ".xlsx",
  ".json",
  ".md",
  ".html",
  ".htm",
  ".xml",
  ".odt",
  ".odp",
  ".ods",
]);

export type UploadKind = "photo" | "document" | "other";

function getExtension (filename: string): string | null {
  const lastDot = filename.lastIndexOf(".");
  if (lastDot === -1) return null;
  return filename.slice(lastDot);
}

function isDocumentType (mimeType: string, filename: string): boolean {
  const normalizedMime = mimeType.toLowerCase();
  if (DOCUMENT_MIME_TYPES.has(normalizedMime)) return true;
  if (DOCUMENT_MIME_PREFIXES.some(prefix => normalizedMime.startsWith(prefix))) return true;

  const ext = getExtension(filename.toLowerCase());
  if (ext && DOCUMENT_EXTENSIONS.has(ext)) return true;

  return false;
}

export function classifyUploadKind (mimeType: string, filename: string): UploadKind {
  const normalizedMime = mimeType.toLowerCase();
  if (normalizedMime.startsWith("image/")) return "photo";
  if (isDocumentType(normalizedMime, filename)) return "document";
  return "other";
}

export function uploadLimitForKind (kind: UploadKind): number {
  if (kind === "photo") return PHOTO_UPLOAD_LIMIT_BYTES;
  if (kind === "document") return DOCUMENT_UPLOAD_LIMIT_BYTES;
  return HARD_UPLOAD_LIMIT_BYTES;
}

export function getUploadSizeError (args: {
  filename: string;
  mimeType: string;
  sizeBytes: number;
}): string | null {
  const { filename, mimeType, sizeBytes } = args;
  const kind = classifyUploadKind(mimeType, filename);
  const limit = uploadLimitForKind(kind);

  if (sizeBytes > limit) {
    const label = kind === "photo" ? "photos" : kind === "document" ? "documents" : "files";
    return `${filename} exceeds the ${label} limit (2 GB max).`;
  }

  return null;
}
