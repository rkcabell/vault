import { z } from "zod";

// ---------------------------------------------------------------------------
// Worker states
// ---------------------------------------------------------------------------

export const MediaWorkerStateSchema = z.enum(["PENDING", "READY", "ERROR", "FAILED"]);
export type MediaWorkerState = z.infer<typeof MediaWorkerStateSchema>;

// ---------------------------------------------------------------------------
// Media list  (GET /media)
// ---------------------------------------------------------------------------

export const MediaListItemSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  filename: z.string(),
  thumbState: MediaWorkerStateSchema,
  textState: MediaWorkerStateSchema,
  createdAt: z.string(), // ISO date string
  tags: z.array(z.string()),
  mimeType: z.string(),
});
export type MediaListItem = z.infer<typeof MediaListItemSchema>;

export const MediaListResponseSchema = z.object({
  items: z.array(MediaListItemSchema),
  nextCursor: z.string().nullable(),
  nextPage: z.number().nullable(),
});
export type MediaListResponse = z.infer<typeof MediaListResponseSchema>;

// ---------------------------------------------------------------------------
// Media detail  (GET /media/:id)
// ---------------------------------------------------------------------------

export const TextSourceSchema = z.enum(["OCR", "NATIVE", "UNKNOWN"]);
export type TextSource = z.infer<typeof TextSourceSchema>;

export const TextLanguageStatusSchema = z.enum(["ok", "short", "error"]);
export type TextLanguageStatus = z.infer<typeof TextLanguageStatusSchema>;

export const TextSegmentSchema = z.object({
  segmentId: z.number(),
  order: z.number(),
  text: z.string(),
});
export type TextSegment = z.infer<typeof TextSegmentSchema>;

export const MediaDocumentSchema = z
  .object({
    rawText: z.string(),
    segments: z.array(TextSegmentSchema),
    textSource: TextSourceSchema.nullable(),
    textTotalLength: z.number(),
    textLanguage: z.string().nullable(),
    textLanguageStatus: TextLanguageStatusSchema.nullable(),
  })
  .nullable();
export type MediaDocument = z.infer<typeof MediaDocumentSchema>;

export const MediaDetailSchema = z.object({
  id: z.string(),
  userId: z.string(),
  title: z.string().nullable(),
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().nullable(),
  storageKey: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  tags: z.array(z.string()),
  thumbState: MediaWorkerStateSchema,
  thumbError: z.string().nullable(),
  textState: MediaWorkerStateSchema,
  thumbnailKey: z.string().nullable(),
  hasText: z.boolean(),
  hasThumb: z.boolean(),
  textError: z.string().nullable(),
  textAttemptsMade: z.number().nullable(),
  textAttemptsTotal: z.number().nullable(),
  linkedBundleId: z.string().nullable().optional(),
  memberBundles: z.array(z.object({ id: z.string(), name: z.string() })).optional(),
  reminders: z.array(z.object({
    id: z.string(),
    title: z.string(),
    note: z.string().nullable(),
    remindAt: z.string(),
    dueAt: z.string(),
  })).optional(),
});
export type MediaDetail = z.infer<typeof MediaDetailSchema>;

// ---------------------------------------------------------------------------
// Media metadata  (nested in GET /media/:id response)
// ---------------------------------------------------------------------------

export const ImageGpsSchema = z.object({
  latitude: z.number(),
  longitude: z.number(),
  altitude: z.number().nullable().optional(),
});
export type ImageGps = z.infer<typeof ImageGpsSchema>;

export const ImageMetadataSchema = z.object({
  make: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  lens: z.string().nullable().optional(),
  iso: z.number().nullable().optional(),
  exposureTime: z.number().nullable().optional(),
  fNumber: z.number().nullable().optional(),
  focalLengthMm: z.number().nullable().optional(),
  orientation: z.number().nullable().optional(),
  colorSpace: z.string().nullable().optional(),
  editedBy: z.string().nullable().optional(),
  capturedAt: z.string().nullable().optional(),
  width: z.number().nullable().optional(),
  height: z.number().nullable().optional(),
  bitDepth: z.number().nullable().optional(),
  hasAlpha: z.boolean().nullable().optional(),
  gps: ImageGpsSchema.nullable().optional(),
});
export type ImageMetadata = z.infer<typeof ImageMetadataSchema>;

export const PdfMetadataSchema = z.object({
  title: z.string().nullable().optional(),
  author: z.string().nullable().optional(),
  subject: z.string().nullable().optional(),
  producer: z.string().nullable().optional(),
  creator: z.string().nullable().optional(),
  pdfVersion: z.string().nullable().optional(),
  pageCount: z.number().nullable().optional(),
  encrypted: z.boolean().nullable().optional(),
  createdAt: z.string().nullable().optional(),
  modifiedAt: z.string().nullable().optional(),
});
export type PdfMetadata = z.infer<typeof PdfMetadataSchema>;

export const OfficeMetadataSchema = z.object({
  application: z.string().nullable().optional(),
  appVersion: z.string().nullable().optional(),
  lastModifiedBy: z.string().nullable().optional(),
  revision: z.number().nullable().optional(),
  language: z.string().nullable().optional(),
  hasComments: z.boolean().nullable().optional(),
  hasTrackedChanges: z.boolean().nullable().optional(),
});
export type OfficeMetadata = z.infer<typeof OfficeMetadataSchema>;

export const TextStatsSchema = z.object({
  totalChars: z.number().nullable().optional(),
  totalWords: z.number().nullable().optional(),
  pageCount: z.number().nullable().optional(),
  pagesWithText: z.number().nullable().optional(),
  avgCharsPerPage: z.number().nullable().optional(),
  avgWordsPerPage: z.number().nullable().optional(),
});
export type TextStats = z.infer<typeof TextStatsSchema>;

export const MediaMetadataSchema = z.object({
  image: ImageMetadataSchema.nullable().optional(),
  pdf: PdfMetadataSchema.nullable().optional(),
  office: OfficeMetadataSchema.nullable().optional(),
  text: TextStatsSchema.nullable().optional(),
});
export type MediaMetadata = z.infer<typeof MediaMetadataSchema>;

export const MediaPermissionsSchema = z.object({
  canEdit: z.boolean(),
  canDelete: z.boolean(),
  canDownload: z.boolean(),
  canOcr: z.boolean(),
});
export type MediaPermissions = z.infer<typeof MediaPermissionsSchema>;

export const MediaDetailResponseSchema = z.object({
  media: MediaDetailSchema,
  document: MediaDocumentSchema, // already nullable
  metadata: MediaMetadataSchema.nullable(),
  permissions: MediaPermissionsSchema.nullable(),
});
export type MediaDetailResponse = z.infer<typeof MediaDetailResponseSchema>;

// ---------------------------------------------------------------------------
// Upload  (POST /media, POST /media/batch-init, POST /media/batch-finalize)
// ---------------------------------------------------------------------------

export const InitUploadResponseSchema = z.object({
  id: z.string(),
  uploadUrl: z.string(),
  storageKey: z.string(),
});
export type InitUploadResponse = z.infer<typeof InitUploadResponseSchema>;

export const BatchInitItemSchema = z.object({
  id: z.string(),
  storageKey: z.string(),
  putUrl: z.string(),
});
export const BatchInitResponseSchema = z.object({
  items: z.array(BatchInitItemSchema),
});
export type BatchInitResponse = z.infer<typeof BatchInitResponseSchema>;

export const FinalizeResponseSchema = z.object({
  ok: z.boolean(),
  count: z.number(),
});
export type FinalizeResponse = z.infer<typeof FinalizeResponseSchema>;

// ---------------------------------------------------------------------------
// Text chunk  (GET /media/:id/text)
// ---------------------------------------------------------------------------

export const TextChunkResponseSchema = z.object({
  text: z.string(),
  offset: z.number(),
  limit: z.number(),
  totalLength: z.number(),
  hasMore: z.boolean(),
  textSource: TextSourceSchema.nullable(),
});
export type TextChunkResponse = z.infer<typeof TextChunkResponseSchema>;

// ---------------------------------------------------------------------------
// Download  (GET /media/:id/download)
// ---------------------------------------------------------------------------

export const DownloadResponseSchema = z.object({
  url: z.string(),
});
export type DownloadResponse = z.infer<typeof DownloadResponseSchema>;

// ---------------------------------------------------------------------------
// Metadata update  (PATCH /media/:id)
// ---------------------------------------------------------------------------

export const MediaUpdateItemSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  filename: z.string(),
  sizeBytes: z.number().nullable(),
  mimeType: z.string(),
  thumbState: MediaWorkerStateSchema,
  textState: MediaWorkerStateSchema,
  tags: z.array(z.string()),
});
export type MediaUpdateItem = z.infer<typeof MediaUpdateItemSchema>;

export const MediaUpdateResponseSchema = z.object({
  media: MediaUpdateItemSchema,
});
export type MediaUpdateResponse = z.infer<typeof MediaUpdateResponseSchema>;

// ---------------------------------------------------------------------------
// Generic  (DELETE /media/:id, POST /media/:id/text, POST /media/:id/text/cancel)
// ---------------------------------------------------------------------------

export const OkResponseSchema = z.object({ ok: z.literal(true) });
export type OkResponse = z.infer<typeof OkResponseSchema>;
