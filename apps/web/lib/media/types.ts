// API-contract types live in @vault/types.
// This file re-exports them so existing imports keep working,
// and adds LoadState which is UI-only (not part of the API contract).

export type {
  MediaWorkerState,
  MediaDetail,
  MediaDocument,
  MediaDetailResponse,
  MediaMetadata,
  MediaPermissions,
  ImageGps,
  ImageMetadata,
  PdfMetadata,
  OfficeMetadata,
  TextStats,
  TextSource,
  TextLanguageStatus,
  TextSegment,
  TextChunkResponse,
  DownloadResponse,
  MediaListItem,
  MediaListResponse,
  MediaUpdateResponse,
  MediaUpdateItem,
  OkResponse,
} from "@vault/types";

// UI-only state — not part of the API contract.
export type LoadState = "loading" | "ready" | "not-found" | "unauthorized" | "error";

// Client-side text search highlight — not part of the API contract.
export type SearchMatch = {
  matchId: string;
  segmentId: number;
  start: number;
  end: number;
  previewText: string;
  previewStart: number;
  previewEnd: number;
};
