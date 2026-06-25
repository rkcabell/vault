/**
 * Single source of truth for which file types are worth enqueueing post-upload
 * processing for. Filtering at enqueue time keeps the OCR and thumbnail queues
 * from filling with jobs that can only ever fail — a real concern when indexing
 * a large repository where most files (source code, .txt, .json, .zip, …) are
 * neither thumbnailable nor OCR-able.
 *
 * Empty/unknown mimeType is treated as supported on purpose: the workers sniff
 * magic bytes and can still succeed, so excluding it would regress currently
 * working thumbnails/OCR for files the browser reported with a generic type.
 */

/**
 * Hard ceiling on the source size the thumbnail worker will attempt. The worker
 * reads the whole file into a Buffer (and ffmpeg/sharp need it in memory too);
 * a file over Node's ~2 GiB Buffer limit can't be loaded at all, so attempting
 * it only wastes a queue slot and fails. Files at/over this size skip thumbnailing.
 */
export const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB

/** Human-readable reason persisted on rows skipped for being too large. */
export const THUMBNAIL_TOO_LARGE_REASON = "File too large for thumbnail (over 2 GB)";

/** Human-readable reason persisted when a file type cannot produce thumbnails. */
export const THUMBNAIL_UNSUPPORTED_REASON = "Unsupported file type for thumbnails";

/** True when a file is too large to thumbnail. Unknown/missing size → not too large
 *  (let the worker try; it sniffs and may still succeed for small files). */
export function exceedsThumbnailSize (sizeBytes: number | null | undefined): boolean {
  return typeof sizeBytes === "number" && sizeBytes > MAX_THUMBNAIL_BYTES;
}

/** True for plain-text MIME types (text/plain, text/markdown, text/csv, text/html).
 *  These are extracted by a direct UTF-8 read — no OCR — see processTextJob. */
export function isPlainTextMime (mimeType: string): boolean {
  return mimeType.toLowerCase().startsWith("text/");
}

/** True for known archive MIME types. Used to explicitly exclude archives from
 *  processing even when mimeType is otherwise ambiguous. */
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
 * Gate for enqueueing a text-extraction job. Covers images and PDFs (OCR /
 * native pdf.js), plain-text files (direct read), and unknown types the worker
 * can sniff. Not strictly "OCR" anymore — plain text never touches ocrmypdf.
 * Archives are explicitly excluded — they produce no text content.
 */
export function ocrSupported (mimeType: string): boolean {
  const m = mimeType.toLowerCase();
  if (isArchiveMime(m)) return false;
  return m === "" || m.startsWith("image/") || m.includes("pdf") || isPlainTextMime(m);
}

/**
 * Hard ceiling on a text file's source size for extraction. We read the whole
 * file into a Buffer and a huge string can exceed Postgres's ~1 MiB tsvector
 * limit (erroring the Document upsert), so files at/over this size skip text
 * extraction. Stored text is additionally truncated to {@link MAX_TEXT_CHARS}.
 */
export const MAX_TEXT_BYTES = 5 * 1024 * 1024; // 5 MiB

/** Human-readable reason persisted on text rows skipped for being too large. */
export const TEXT_TOO_LARGE_REASON = "File too large for text extraction (over 5 MB)";

/** Human-readable reason surfaced when a file type can't produce extractable text. */
export const TEXT_UNSUPPORTED_REASON = "Text extraction isn't supported for this file type";

/** Max characters of extracted plain text persisted (keeps to_tsvector under its
 *  ~1 MiB ceiling regardless of source size). */
export const MAX_TEXT_CHARS = 1_000_000;

/** True when a text file is too large to extract. Unknown/missing size → not too
 *  large (let the worker try). */
export function exceedsTextSize (sizeBytes: number | null | undefined): boolean {
  return typeof sizeBytes === "number" && sizeBytes > MAX_TEXT_BYTES;
}

/**
 * Thumbnails are generated for images (incl. heic/heif), video (ffmpeg frame),
 * and PDFs (first page). Mirrors the FORMAT_HANDLERS + Sharp fallback in
 * thumbnailService.ts.
 */
export function thumbnailSupported (mimeType: string): boolean {
  const m = mimeType.toLowerCase();
  return m === "" || m.startsWith("image/") || m.startsWith("video/") || m.includes("pdf");
}
