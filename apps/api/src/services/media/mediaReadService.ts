import type { FastifyBaseLogger } from "fastify";
import type { Queue } from "bullmq";
import type { MediaRepository } from "../../repositories/mediaRepository.js";
import type { S3Adapter } from "../../adapters/s3Adapter.js";
import type { OcrJobData } from "../ocrProcessingService.js";
import { computeThumbKey } from "../../queues/enqueueThumbnail.js";
import { inferTextSource } from "../../lib/media/textSource.js";
import { detectTextLanguage } from "../../lib/text/detectLanguage.js";
import { segmentExtractedText } from "../../lib/text/segmentText.js";
import type { PdfTextPage } from "../pdf/extractPdfText.js";
import { buildTextStats } from "./metadata/textStats.js";
import type { MediaMetadata } from "./metadata/types.js";

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

// Prisma JSON fields come through as broad JsonValue; normalize before using as typed page arrays.
// function parsePdfTextPages (value: unknown): PdfTextPage[] | null {
//   if (!Array.isArray(value)) return null;

//   const pages: PdfTextPage[] = [];
//   for (const item of value) {
//     if (typeof item !== "object" || item === null) return null;
//     const rec = item as Record<string, unknown>;

//     const pageNumber = rec.pageNumber;
//     const text = rec.text;
//     const numChars = rec.numChars;

//     if (typeof pageNumber !== "number") return null;
//     if (typeof text !== "string") return null;

//     pages.push({
//       pageNumber,
//       text,
//       numChars: typeof numChars === "number" ? numChars : text.length,
//     });
//   }

//   return pages;
// }

type MediaReadDeps = {
  repository: MediaRepository;
  s3Adapter: S3Adapter;
  bucket: string;
  logger: FastifyBaseLogger;
  ocrQueue?: Queue<OcrJobData>;
};

export function createMediaReadService (deps: MediaReadDeps) {
  const getOcrJobMeta = async (
    mediaId: string,
    textState?: string | null,
  ): Promise<{
    textError: string | null;
    textAttemptsMade: number | null;
    textAttemptsTotal: number | null;
  } | null> => {
    if (!deps.ocrQueue) return null;

    const includeAttempts = textState === "PENDING";
    const includeError = textState === "ERROR" || textState === "FAILED";
    if (!includeAttempts && !includeError) return null;

    try {
      const match = await deps.ocrQueue.getJob(`ocr-${mediaId}`);

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

    // Read stored metadata from joined DB query — no S3 download on the read path.
    const storedData = media.extractedMetadata?.data as Partial<MediaMetadata> | null | undefined;
    const textStats = buildTextStats(media.document);
    const metadata: MediaMetadata | null =
      storedData || textStats
        ? { ...storedData, ...(textStats ? { text: textStats } : {}) }
        : null;

    const { ...mediaPayload } = media;
    const jobMeta = await getOcrJobMeta(media.id, media.textState);

    return {
      media: {
        ...mediaPayload,
        hasText: textTotalLength > 0,
        hasThumb: Boolean(media.thumbnailKey),
        textError: jobMeta?.textError ?? null,
        textAttemptsMade: jobMeta?.textAttemptsMade ?? null,
        textAttemptsTotal: jobMeta?.textAttemptsTotal ?? null,
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

  const getThumbnail = async (id: string) => {
    const thumbKey = computeThumbKey(id);
    try {
      const res = await deps.s3Adapter.getObjectStream({
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

  return {
    getTextChunk,
    getMediaDetail,
    getThumbnail,
  };
}
