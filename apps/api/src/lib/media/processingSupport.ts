/**
 * Decides which file types are worth queueing derivative work for. Filtering
 * here keeps the text and thumbnail queues from filling with jobs that can only
 * fail, which matters when indexing a folder of source code or archives. An
 * empty or unknown MIME type counts as supported: the workers read the file's
 * leading bytes and may still succeed.
 */

/**
 * Ceiling on the file size the thumbnail worker will attempt. The worker reads
 * the whole file into a Buffer, and Node cannot hold more than about 2 GiB in
 * one, so a larger file can only occupy a queue slot and fail.
 */
export const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB
export const THUMBNAIL_TOO_LARGE_REASON = "File too large for thumbnail (over 2 GB)";
export const THUMBNAIL_UNSUPPORTED_REASON = "Unsupported file type for thumbnails";

/** True when the file is too large to render a thumbnail from. */
export function exceedsThumbnailSize (sizeBytes: number | null | undefined): boolean {
  return typeof sizeBytes === "number" && sizeBytes > MAX_THUMBNAIL_BYTES;
}

export function isPlainTextMime (mimeType: string): boolean {
  return mimeType.toLowerCase().startsWith("text/");
}

export function isArchiveMime (mimeType: string): boolean {
  const m = mimeType.toLowerCase();
  return (
    m === "application/zip" ||
    m === "application/x-zip-compressed" ||
    m === "application/x-tar" ||
    m === "application/gzip" ||
    m === "application/x-gzip" ||
    m === "application/x-7z-compressed" ||
    m === "application/x-rar-compressed" ||
    m === "application/vnd.rar"
  );
}

/**
 * True when a text-extraction job is worth queueing: images, PDFs, plain text,
 * and unknown types. Archives are excluded.
 */
export function ocrSupported (mimeType: string): boolean {
  const m = mimeType.toLowerCase();
  if (isArchiveMime(m)) return false;
  return m === "" || m.startsWith("image/") || m.includes("pdf") || isPlainTextMime(m);
}

/**
 * Ceiling on the size of a text file this will extract from. The whole file
 * becomes one string, and a large one exceeds the roughly 1 MiB Postgres allows
 * in a tsvector, which fails the write. Stored text is truncated further, to
 * {@link MAX_TEXT_CHARS}.
 */
export const MAX_TEXT_BYTES = 5 * 1024 * 1024; // 5 MiB
export const TEXT_TOO_LARGE_REASON = "File too large for text extraction (over 5 MB)";
export const TEXT_UNSUPPORTED_REASON = "Text extraction isn't supported for this file type";
export const MAX_TEXT_CHARS = 1_000_000;

/** True when the file is too large to extract text from. */
export function exceedsTextSize (sizeBytes: number | null | undefined): boolean {
  return typeof sizeBytes === "number" && sizeBytes > MAX_TEXT_BYTES;
}

/** True when the thumbnail worker can render this type. */
export function thumbnailSupported (mimeType: string): boolean {
  const m = mimeType.toLowerCase();
  return m === "" || m.startsWith("image/") || m.startsWith("video/") || m.includes("pdf");
}
