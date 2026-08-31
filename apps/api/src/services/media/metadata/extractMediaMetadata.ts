import type { ExtractArgs, MediaMetadata } from "./types.js";
import { getSourceBuffer } from "./sourceBuffer.js";
import { buildTextStats } from "./textStats.js";
import { extractImageMetadata } from "./image/extractImageMetadata.js";
import { extractPdfMetadata } from "./pdf/extractPdfMetadata.js";
import { extractOfficeMetadata } from "./office/extractOfficeMetadata.js";

/**
 * Chooses the extractor that matches a file's type, and merges what it returns
 * into one metadata record.
 */

/**
 * Extracts image, PDF or Office metadata from a buffer already in memory. Reads
 * nothing, and returns no text statistics: those come from the stored document
 * record instead.
 */
export async function extractMetadataFromBuffer(
  buffer: Buffer,
  mimeType: string,
): Promise<MediaMetadata | null> {
  const mime = mimeType.toLowerCase();
  const metadata: MediaMetadata = {};

  if (mime.startsWith("image/")) {
    metadata.image = await extractImageMetadata(buffer);
  } else if (mime.includes("pdf")) {
    metadata.pdf = await extractPdfMetadata(buffer);
  } else if (mime.includes("officedocument")) {
    metadata.office = extractOfficeMetadata(buffer);
  }

  return Object.keys(metadata).length > 0 ? metadata : null;
}

/**
 * Reads the file from storage and returns everything known about it, including
 * the text statistics. Null when nothing could be extracted.
 */
export async function extractMediaMetadata (args: ExtractArgs): Promise<MediaMetadata | null> {
  const { media, document, storage, bucket, logger } = args;
  const metadata: MediaMetadata = {};

  const textStats = buildTextStats(document);
  if (textStats) metadata.text = textStats;

  const mimeType = (media.mimeType ?? "").toLowerCase();
  const isImage = mimeType.startsWith("image/");
  const isPdf = mimeType.includes("pdf");
  const isOffice = mimeType.includes("officedocument");

  if (!isImage && !isPdf && !isOffice) {
    return Object.keys(metadata).length ? metadata : null;
  }

  if (!media.storageKey) {
    return Object.keys(metadata).length ? metadata : null;
  }

  const sourceBuffer = await getSourceBuffer({
    bucket,
    key: media.storageKey,
    storage,
    logger,
    mediaId: media.id,
  });

  if (!sourceBuffer) {
    return Object.keys(metadata).length ? metadata : null;
  }

  if (isImage) {
    metadata.image = await extractImageMetadata(sourceBuffer);
  }

  if (isPdf) {
    metadata.pdf = await extractPdfMetadata(sourceBuffer);
  }

  if (isOffice) {
    metadata.office = extractOfficeMetadata(sourceBuffer);
  }

  return Object.keys(metadata).length ? metadata : null;
}
