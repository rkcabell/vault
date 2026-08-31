/**
 * Re-exports the media metadata extractor and its result types from `metadata/`.
 */

export { extractMediaMetadata } from "./metadata/extractMediaMetadata.js";
export type {
  ImageGps,
  ImageMetadata,
  MediaMetadata,
  OfficeMetadata,
  PdfMetadata,
  TextStats,
} from "./metadata/types.js";
