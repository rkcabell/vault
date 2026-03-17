import type { ExtractArgs, MediaMetadata } from "./types.js";
import { getSourceBuffer } from "./sourceBuffer.js";
import { buildTextStats } from "./textStats.js";
import { extractImageMetadata } from "./image/extractImageMetadata.js";
import { extractPdfMetadata } from "./pdf/extractPdfMetadata.js";
import { extractOfficeMetadata } from "./office/extractOfficeMetadata.js";

/**
 * Extract image/PDF/office metadata from an already-downloaded buffer.
 * Does not touch S3 and does not include text stats (those are derived from
 * the Document record in the read path).
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

export async function extractMediaMetadata (args: ExtractArgs): Promise<MediaMetadata | null> {
  const { media, document, s3Adapter, bucket, logger } = args;
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
    s3Adapter,
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
