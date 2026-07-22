import type { FastifyBaseLogger } from "fastify";
import type { StorageAdapter } from "../../../adapters/storage/types.js";

export type ImageGps = {
  latitude: number;
  longitude: number;
  altitude?: number | null;
};

export type ImageMetadata = {
  make?: string | null;
  model?: string | null;
  lens?: string | null;
  iso?: number | null;
  exposureTime?: number | null;
  fNumber?: number | null;
  focalLengthMm?: number | null;
  orientation?: number | null;
  colorSpace?: string | null;
  editedBy?: string | null;
  capturedAt?: string | null;
  width?: number | null;
  height?: number | null;
  bitDepth?: number | null;
  hasAlpha?: boolean | null;
  gps?: ImageGps | null;
};

export type PdfMetadata = {
  title?: string | null;
  author?: string | null;
  subject?: string | null;
  producer?: string | null;
  creator?: string | null;
  pdfVersion?: string | null;
  pageCount?: number | null;
  encrypted?: boolean | null;
  createdAt?: string | null;
  modifiedAt?: string | null;
};

export type OfficeMetadata = {
  application?: string | null;
  appVersion?: string | null;
  lastModifiedBy?: string | null;
  revision?: number | null;
  language?: string | null;
  hasComments?: boolean | null;
  hasTrackedChanges?: boolean | null;
};

export type TextStats = {
  totalChars?: number | null;
  totalWords?: number | null;
  pageCount?: number | null;
  pagesWithText?: number | null;
  avgCharsPerPage?: number | null;
  avgWordsPerPage?: number | null;
};

export type MediaMetadata = {
  image?: ImageMetadata | null;
  pdf?: PdfMetadata | null;
  office?: OfficeMetadata | null;
  text?: TextStats | null;
};

export type ExtractArgs = {
  media: {
    id: string;
    mimeType?: string | null;
    storageKey?: string | null;
  };
  document?: {
    rawText?: string | null;
    pages?: unknown | null;
  } | null;
  storage: StorageAdapter;
  bucket: string;
  logger: FastifyBaseLogger;
};
