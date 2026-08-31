import type { FastifyBaseLogger } from "fastify";
import type { Queue } from "bullmq";
import type { MediaRepository } from "../../repositories/mediaRepository.js";
import type { StorageAdapter } from "../../adapters/storage/types.js";
import type { OcrJobData } from "../ocrProcessingService.js";
import { computeThumbKey } from "../../queues/enqueueThumbnail.js";
import { textJobId } from "../../queues/enqueueText.js";
import { openSourceStream } from "../../adapters/storage/openSource.js";
import { inferTextSource } from "../../lib/media/textSource.js";
import { detectTextLanguage } from "../../lib/text/detectLanguage.js";
import { segmentExtractedText } from "../../lib/text/segmentText.js";
import type { PdfTextPage } from "../pdf/extractPdfText.js";
import { buildTextStats } from "./metadata/textStats.js";
import { exceedsTextSize, isPlainTextMime, TEXT_TOO_LARGE_REASON, TEXT_UNSUPPORTED_REASON } from "../../lib/media/processingSupport.js";
import type { MediaMetadata } from "./metadata/types.js";

/**
 * Reads a single media item for the detail page, and streams its thumbnail or
 * its source file. The detail payload comes from one database join and opens no
 * files.
 */

/**
 * Converts the JSON stored in `Media.document.pages` into typed pages. Returns
 * null when any entry is missing a required field, so a partly valid value is
 * treated as absent. `numChars` falls back to the text length for rows that do
 * not carry it.
 */
function normalizePdfTextPages (value: unknown): PdfTextPage[] | null {
  if (!Array.isArray(value)) return null;

  const out: PdfTextPage[] = [];

  for (const item of value) {
    if (typeof item !== "object" || item === null) return null;
    const rec = item as Record<string, unknown>;

    const pageNumber = rec.pageNumber;
    const text = rec.text;

    if (typeof pageNumber !== "number") return null;
    if (typeof text !== "string") return null;

    const numCharsRaw = rec.numChars;
    const numChars = typeof numCharsRaw === "number" ? numCharsRaw : text.length;

    out.push({ pageNumber, text, numChars });
  }

  return out;
}

type MediaReadDeps = {
  repository: MediaRepository;
  storage: StorageAdapter;
  bucket: string;
  logger: FastifyBaseLogger;
  /** Tier 2 (`ocr_queue`). Read before `textQueue`: when both hold a job for one
   *  item, the OCR run is the one still in progress. */
  ocrQueue?: Queue<OcrJobData>;
  /** Tier 1 (`text_queue`). */
  textQueue?: Queue<OcrJobData>;
};

export function createMediaReadService (deps: MediaReadDeps) {
  /**
   * Returns what the detail page shows about text extraction: attempt progress
   * while `textState` is PENDING, the failure reason when it is ERROR, and a
   * fixed reason when it is UNSUPPORTED. Null in every other state, and null
   * when the job lookup fails.
   */
  const getOcrJobMeta = async (
    mediaId: string,
    textState?: string | null,
    mimeType?: string | null,
    sizeBytes?: number | null,
  ): Promise<{
    textError: string | null;
    textAttemptsMade: number | null;
    textAttemptsTotal: number | null;
  } | null> => {
    // An UNSUPPORTED item never ran a job. The reason is derived the same way
    // the worker decides to skip one: only plain text over the size cap counts
    // as too large.
    if (textState === "UNSUPPORTED") {
      const isTooLarge = isPlainTextMime((mimeType ?? "").toLowerCase()) && exceedsTextSize(sizeBytes);
      const textError = isTooLarge ? TEXT_TOO_LARGE_REASON : TEXT_UNSUPPORTED_REASON;
      return { textError, textAttemptsMade: null, textAttemptsTotal: null };
    }

    if (!deps.ocrQueue && !deps.textQueue) return null;

    const includeAttempts = textState === "PENDING";
    const includeError = textState === "ERROR";
    if (!includeAttempts && !includeError) return null;

    try {
      // Both tiers key on the same job id, in separate BullMQ key spaces, so a
      // PENDING row's job can be on either.
      const jobId = textJobId(mediaId);
      const match =
        (await deps.ocrQueue?.getJob(jobId)) ?? (await deps.textQueue?.getJob(jobId));

      if (!match) return null;

      const attemptsTotal = match.opts?.attempts ?? null;
      const attemptsMade = match.attemptsMade ?? null;
      const nextAttempt =
        includeAttempts && typeof attemptsMade === "number"
          ? Math.max(1, attemptsMade + 1)
          : attemptsMade;
      const clampedAttempt =
        typeof nextAttempt === "number" && attemptsTotal && attemptsTotal > 0
          ? Math.min(attemptsTotal, nextAttempt)
          : nextAttempt;

      const textError = includeError
        ? match.failedReason ?? (match.stacktrace?.length ? match.stacktrace[0] : null)
        : null;

      return {
        textError,
        textAttemptsMade: typeof clampedAttempt === "number" ? clampedAttempt : null,
        textAttemptsTotal: typeof attemptsTotal === "number" ? attemptsTotal : null,
      };
    } catch (err) {
      deps.logger.warn({ err, mediaId }, "[media] OCR job lookup failed");
      return null;
    }
  };

  /**
   * Returns a slice of a document's extracted text. The lookup is scoped to
   * `userId`, which is the ownership check.
   */
  const getTextChunk = async (userId: string, id: string, offset: number, limit: number) => {
    const media = await deps.repository.findDocumentForUser(userId, id);
    if (!media) return null;

    const rawText = media.document?.rawText ?? "";
    const totalLength = rawText.length;
    const text = rawText.slice(offset, offset + limit);
    const hasMore = offset + text.length < totalLength;
    const textSource = inferTextSource({
      documentTextSource: media.document?.textSource,
      mimeType: media.mimeType,
    });

    return {
      text,
      offset,
      limit,
      totalLength,
      hasMore,
      textSource,
    };
  };

  /**
   * Returns everything the detail page renders for one item: its stored fields,
   * its text split into sections, the detected language, the extraction
   * metadata, and the state of any text job. One database join supplies it all.
   */
  const getMediaDetail = async (userId: string, id: string) => {
    const media = await deps.repository.findDetail(userId, id);
    if (!media) return null;

    const rawText = media.document?.rawText ?? "";
    const segments = media.document
      ? segmentExtractedText({ rawText, pages: normalizePdfTextPages(media.document.pages) })
      : [];
    const textTotalLength = segments.reduce((total, segment) => total + segment.text.length, 0);
    const textSource = inferTextSource({
      documentTextSource: media.document?.textSource,
      mimeType: media.mimeType,
    });
    const detectedLanguage = media.document ? detectTextLanguage(rawText) : null;

    const storedData = media.extractedMetadata?.data as Partial<MediaMetadata> | null | undefined;
    const textStats = buildTextStats(media.document);
    const metadata: MediaMetadata | null =
      storedData || textStats
        ? { ...storedData, ...(textStats ? { text: textStats } : {}) }
        : null;

    const { ...mediaPayload } = media;
    const jobMeta = await getOcrJobMeta(media.id, media.textState, media.mimeType, media.sizeBytes);
    // The tags on this item that the system applied, so the UI can show the
    // user's own tags first.
    const autoTags = await deps.repository.listAutoTagNames(userId, media.tags);

    return {
      autoTags,
      media: {
        ...mediaPayload,
        hasText: textTotalLength > 0,
        hasThumb: Boolean(media.thumbnailKey),
        textError: jobMeta?.textError ?? null,
        textAttemptsMade: jobMeta?.textAttemptsMade ?? null,
        textAttemptsTotal: jobMeta?.textAttemptsTotal ?? null,
        memberBundles: media.bundleItems.map(bi => bi.bundle),
        reminders: media.reminders.map(r => ({
          id: r.id,
          title: r.title,
          note: r.note,
          remindAt: r.remindAt.toISOString(),
          dueAt: r.dueAt.toISOString(),
        })),
      },
      document: media.document
        ? {
            rawText,
            segments,
            textSource,
            textTotalLength,
            textLanguage: detectedLanguage?.label ?? null,
            textLanguageStatus: detectedLanguage?.status ?? null,
          }
        : null,
      metadata,
      permissions: {
        canEdit: true,
        canDelete: true,
        canDownload: true,
        canOcr: true,
      },
    };
  };

  /**
   * Returns how many items sit ahead of this one in the tier-1 text backlog.
   * Null when the item is not the caller's, or is no longer waiting.
   */
  const getTextQueuePosition = async (userId: string, id: string) => {
    return deps.repository.countTextBacklogAhead(userId, id);
  };

  /**
   * Streams an item's thumbnail from storage. Returns null when the object is
   * missing or the read fails.
   */
  const getThumbnail = async (id: string) => {
    const thumbKey = computeThumbKey(id);
    try {
      const res = await deps.storage.getObjectStream({
        bucket: deps.bucket,
        key: thumbKey,
      });
      if (!res) return null;
      return {
        body: res.body,
        etag: res.etag,
      };
    } catch (err) {
      deps.logger.warn({ err, thumbKey }, "[media] thumbnail fetch failed");
      return null;
    }
  };

  /**
   * Streams the original file of an item indexed in place, read-only from its
   * source path. Returns null when the item is missing, is not indexed in place,
   * or its file is gone. A managed item downloads through `getDownloadUrl`.
   */
  const getSourceStream = async (
    userId: string,
    id: string,
    allowedRoots: string[],
    range?: { start: number; end: number },
  ) => {
    const media = await deps.repository.findSourceInfo(userId, id);
    if (!media || !media.sourcePath) return null;

    try {
      const res = await openSourceStream({
        storage: deps.storage,
        bucket: deps.bucket,
        storageKey: media.storageKey,
        sourcePath: media.sourcePath,
        allowedRoots,
        range,
      });
      if (!res) return null;
      return {
        body: res.body,
        contentLength: res.contentLength,
        totalLength: res.totalLength ?? res.contentLength,
        mimeType: media.mimeType || "application/octet-stream",
        filename: media.filename,
      };
    } catch (err) {
      deps.logger.warn({ err, mediaId: id }, "[media] source stream failed");
      return null;
    }
  };

  /** Returns the fields the "reveal in file manager" action needs to resolve a path. */
  const getStorageKey = async (userId: string, id: string) => {
    return deps.repository.findStorageKey(userId, id);
  };

  return {
    getTextChunk,
    getMediaDetail,
    getTextQueuePosition,
    getThumbnail,
    getSourceStream,
    getStorageKey,
  };
}
