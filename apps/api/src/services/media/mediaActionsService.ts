import crypto from "node:crypto";
import path from "node:path";
import type { Writable } from "node:stream";
import archiver from "archiver";
import type { Queue } from "bullmq";
import type { OcrJobData } from "../ocrProcessingService.js";
import type { MediaRepository } from "../../repositories/mediaRepository.js";
import type { BundleRepository } from "../../repositories/bundleRepository.js";
import type { StorageAdapter } from "../../adapters/storage/types.js";
import { openSourceStream } from "../../adapters/storage/openSource.js";
import type { ThumbJob } from "../../queues/enqueueThumbnail.js";
import { computeThumbKey, enqueueThumbBulk } from "../../queues/enqueueThumbnail.js";
import { enqueueOcrBulk } from "../../queues/enqueueOcr.js";
import type { UnpackJob } from "../../queues/enqueueUnpack.js";
import type { IndexJobData } from "../../queues/enqueueIndex.js";
import { makeStorageKey } from "../../lib/media/keys.js";
import { extractArchive, isCoverCandidate } from "../archive/extractArchive.js";
import { normalizeTag, normalizeTags } from "../../lib/tags/normalizeTags.js";
import { evaluateRules, type TagRuleInput } from "../../lib/tags/rules/evaluateRules.js";
import { ARCHIVE_MIME_TYPES } from "../../lib/media/archiveTypes.js";
import { ocrSupported, thumbnailSupported } from "../../lib/media/processingSupport.js";
import { signalIndexAbort, type AbortRedis } from "../../lib/media/indexAbort.js";

const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/heic": ".heic",
  "image/heif": ".heif",
  "image/tiff": ".tiff",
  "image/bmp": ".bmp",
  "image/svg+xml": ".svg",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/x-msvideo": ".avi",
  "video/webm": ".webm",
  "video/x-matroska": ".mkv",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
  "text/html": ".html",
  "text/csv": ".csv",
  "application/json": ".json",
  "application/zip": ".zip",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.ms-excel": ".xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.ms-powerpoint": ".ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
};

/**
 * Coerce an arbitrary string into a valid tag by stripping invalid characters
 * before passing through the canonical normalizeTag path. Returns null if the
 * result cannot produce a valid tag (e.g. empty after stripping).
 */
function coerceTag(name: string): string | null {
  const prepped = name
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  try {
    return normalizeTag(prepped);
  } catch {
    return null;
  }
}

function sanitizeTitle (title: string): string {
  const cleaned = title.replace(/[/\\:*?"<>|]/g, "").trim().slice(0, 100);
  return cleaned || "";
}

function extFromFilename (filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(dot) : "";
}

function buildFilename (
  item: { id: string; title: string; mimeType: string | null; filename: string },
  usedNames: Set<string>,
): string {
  const ext =
    (item.mimeType && MIME_TO_EXT[item.mimeType]) ??
    extFromFilename(item.filename) ??
    "";
  const base = sanitizeTitle(item.title) || item.id;
  let name = `${base}${ext}`;
  if (!usedNames.has(name)) {
    usedNames.add(name);
    return name;
  }
  let counter = 2;
  while (usedNames.has(name)) {
    name = `${base}_${counter}${ext}`;
    counter++;
  }
  usedNames.add(name);
  return name;
}

const MAX_PRESIGNED_SECONDS = 600;

export type TextExtractionOptions = {
  language?: string;
  rotation?: "0" | "90" | "180" | "270";
  forceOcr?: boolean;
};


type MediaActionsDeps = {
  repository: MediaRepository;
  bundleRepository: BundleRepository;
  storage: StorageAdapter;
  bucket: string;
  ocrQueue: Queue<OcrJobData>;
  thumbQueue: Queue<ThumbJob>;
  // Optional so unit tests that only exercise media actions don't have to wire
  // every queue. The route always provides them for the dev abort endpoint.
  unpackQueue?: Queue<UnpackJob>;
  indexQueue?: Queue<IndexJobData>;
  // Used by the dev abort to bump the index-abort epoch (stops an in-flight walk).
  redis?: Pick<AbortRedis, "incr">;
  /** The user's enabled Tag Organizer rules, applied to unpacked archive
   *  entries. Optional so tests that never unpack don't have to wire it. */
  listTagRules?: (userId: string) => Promise<TagRuleInput[]>;
  /** Publishes a media event so open library views refresh without a manual
   *  reload (delete removes an item, unpack creates children). */
  publishJobUpdate?: (update: { userId: string; mediaId: string; field: string; value: string }) => void;
};

export function createMediaActionsService (deps: MediaActionsDeps) {
  const deleteMedia = async (userId: string, id: string) => {
    const media = await deps.repository.findMediaKeys(userId, id);
    if (!media) return null;

    // In-place indexed items live on the user's drive; Vault must never delete
    // the source. Only managed originals are removed from storage.
    if (!media.sourcePath) {
      await deps.storage.deleteIfPresent({ bucket: deps.bucket, key: media.storageKey });
    }
    if (media.thumbnailKey) {
      await deps.storage.deleteIfPresent({ bucket: deps.bucket, key: media.thumbnailKey });
    }

    await deps.repository.deleteMedia(id);

    // Clear coverMediaId on any bundle that used this media as its cover.
    await deps.bundleRepository.clearCoverMedia(id);

    // Remove any BullMQ jobs for this media item so failed counts stay accurate.
    // OCR jobs use jobId "ocr-{id}"; thumb jobs use jobId "{id}".
    await Promise.allSettled([
      deps.ocrQueue.getJob(`ocr-${id}`).then(job => job?.remove().catch(() => {})),
      deps.thumbQueue.getJob(id).then(job => job?.remove().catch(() => {})),
    ]);

    // Cross-tab/view refresh: the deleting page updates itself optimistically,
    // but any other open library view only learns of the removal from this event.
    deps.publishJobUpdate?.({ userId, mediaId: id, field: "mediaDeleted", value: "1" });

    return { ok: true };
  };

  const updateMediaMetadata = async (
    userId: string,
    id: string,
    data: { title?: string; tags?: string[] },
  ) => {
    const media = await deps.repository.findMediaForUpdate(userId, id);
    if (!media) return null;

    // Normalize here, not only at the HTTP edge — any caller of this service
    // must not be able to persist raw tags (count drift + case mismatches).
    const normalized = data.tags !== undefined
      ? { ...data, tags: normalizeTags(data.tags) }
      : data;

    return deps.repository.updateMetadata(media.id, normalized, userId);
  };

  const enqueueTextExtraction = async (
    userId: string,
    id: string,
    options: TextExtractionOptions,
    allowedRoots: string[] = [],
  ) => {
    const media = await deps.repository.findForTextJob(userId, id);
    if (!media) return null;

    // Check if file type supports text extraction. If not, mark as unsupported.
    if (!ocrSupported(media.mimeType ?? "")) {
      await deps.repository.markTextUnsupported([id]);
      return { ok: true };
    }

    // BullMQ deduplicates by jobId — a completed or failed job with the same id
    // blocks new adds silently. Remove any stale terminal job before re-queueing.
    const staleJob = await deps.ocrQueue.getJob(`ocr-${media.id}`);
    if (staleJob) {
      try {
        await staleJob.remove();
      } catch {
        // Active jobs cannot be removed; dedup will prevent a duplicate (correct).
      }
    }

    await deps.ocrQueue.add(
      "ocr",
      {
        mediaId: media.id,
        userId,
        storageKey: media.storageKey,
        title: media.title,
        language: options.language,
        rotation: options.rotation,
        forceOcr: options.forceOcr ?? false,
        // In-place indexed items read their original from disk. Carry the
        // caller's current allow-list snapshot so the worker can re-validate
        // the source path — the worker's env-based allowedRoots are empty now
        // that the list lives in user preferences, so without this the source
        // read is rejected and re-extraction fails. Mirrors regenerateThumbnail.
        ...(media.sourcePath ? { allowedRoots } : {}),
      },
      { attempts: 1, jobId: `ocr-${media.id}`, removeOnFail: true, removeOnComplete: true },
    );

    await deps.repository.setTextStatePending(id);

    return { ok: true };
  };

  const cancelTextExtraction = async (userId: string, id: string) => {
    const media = await deps.repository.findForTextJob(userId, id);
    if (!media) return null;

    const job = await deps.ocrQueue.getJob(`ocr-${media.id}`);
    if (job) {
      try {
        await job.remove();
      } catch {
        // Active jobs cannot be removed; cancellation is best-effort.
      }
    }

    await deps.repository.setTextState(media.id, "ERROR");

    return { ok: true };
  };

  const getDownloadUrl = async (userId: string, id: string) => {
    const media = await deps.repository.findStorageKey(userId, id);
    if (!media) return null;

    // In-place originals can't be presigned (they're outside storage) — stream
    // them through the same-origin source proxy, which authenticates by cookie.
    if (media.sourcePath) {
      return { url: `/api/media/${id}/source` };
    }

    const url = await deps.storage.presignGet({
      bucket: deps.bucket,
      key: media.storageKey,
      expiresSeconds: MAX_PRESIGNED_SECONDS,
    });

    return { url };
  };

  const getBulkDownloadItems = async (userId: string, ids: string[]) => {
    return deps.repository.findBulkDownloadItems(userId, ids);
  };

  const streamBulkArchive = async (
    items: { id: string; storageKey: string; sourcePath?: string | null; title: string; mimeType: string | null; filename: string }[],
    dest: Writable,
    logger: { error: (obj: unknown, msg: string) => void },
    allowedRoots: string[],
  ) => {
    const archive = archiver("zip", { zlib: { level: 0 } });

    archive.on("error", (err) => {
      logger.error(err, "bulk-download archive error");
      if (!dest.writableEnded) dest.destroy(err);
    });

    archive.pipe(dest);

    const usedNames = new Set<string>();
    for (const item of items) {
      // In-place items stream from disk; managed items from storage. openSourceStream
      // branches on sourcePath and re-validates it against the allow-list.
      const result = await openSourceStream({
        storage: deps.storage,
        bucket: deps.bucket,
        storageKey: item.storageKey,
        sourcePath: item.sourcePath,
        allowedRoots,
      });
      if (!result) continue;
      const filename = buildFilename(item, usedNames);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      archive.append(result.body as any, { name: filename });
    }

    await archive.finalize();
  };

  const regenerateThumbnail = async (userId: string, id: string, allowedRoots: string[] = []) => {
    const media = await deps.repository.findMediaKeys(userId, id);
    if (!media) return null;

    // Don't re-queue a thumbnail for a type the worker can't render (e.g. a
    // watched .txt being edited fires onChange → regenerate). No-op cleanly.
    if (!thumbnailSupported(media.mimeType ?? "")) {
      await deps.repository.markThumbUnsupported([id]);
      return { ok: true, queued: false };
    }

    await deps.repository.resetThumbState(id);

    await deps.thumbQueue.add(
      "thumb",
      {
        type: "thumb",
        mediaId: id,
        userId,
        storageKey: media.storageKey,
        outKey: computeThumbKey(id),
        size: 512,
        // In-place indexed items read their original from disk. Carry the path
        // and the caller's current allow-list snapshot so the worker can
        // re-validate it — the worker's env-based allowedRoots are empty now
        // that the list lives in user preferences, so without this the source
        // read is rejected and regeneration fails with SOURCE_NOT_READY.
        ...(media.sourcePath ? { sourcePath: media.sourcePath, allowedRoots } : {}),
      },
      { jobId: `thumb-regen-${id}-${Date.now()}`, attempts: 3, backoff: { type: "exponential", delay: 2000 }, removeOnFail: true, removeOnComplete: true },
    );

    return { ok: true };
  };

  /**
   * Move a pending thumbnail job to the front of the queue. Called when a user
   * opens an item's detail page so its thumbnail is generated ahead of a large
   * backlog (e.g. the tens of thousands of jobs queued after indexing a folder).
   *
   * Uses changePriority({ lifo: true }) rather than a numeric priority on
   * purpose: in BullMQ an *unprioritized* job (the default for our thumb jobs)
   * outranks every job that has a numeric priority, so promoting via pri:1 would
   * actually push the item *behind* the existing unprioritized backlog. lifo
   * keeps the job unprioritized but RPUSHes it to the tail of the wait list,
   * which is exactly where the worker pops next (RPOPLPUSH). No backlog
   * migration required.
   *
   * No-op when the job is already gone (completed/removed) or active — those
   * can't or needn't be reprioritized.
   */
  const prioritizeThumbnail = async (id: string) => {
    try {
      const job = await deps.thumbQueue.getJob(id);
      if (!job) return { ok: false };
      await job.changePriority({ lifo: true });
      return { ok: true };
    } catch {
      // Job became active/completed between the lookup and the change — fine.
      return { ok: false };
    }
  };

  /** Toggle the star on a media item (mirrors the bundle star). Returns the
   *  new starred state, or null when the item isn't the user's. */
  const toggleStar = async (userId: string, id: string): Promise<boolean | null> => {
    return deps.repository.toggleStar(id, userId);
  };

  const unpackArchive = async (
    userId: string,
    mediaId: string,
  ): Promise<{ bundleId: string } | null | "already-linked" | "not-archive"> => {
    // Load the media item including its mimeType and title
    const media = await deps.repository.findDetail(userId, mediaId);
    if (!media) return null;

    // Already unpacked
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((media as any).linkedBundleId) return "already-linked";

    // Only proceed for recognised archive types (ZIP, TAR, GZ)
    if (!ARCHIVE_MIME_TYPES.has(media.mimeType)) return "not-archive";

    // Fetch the archive stream from S3
    const s3Result = await deps.storage.getObjectStream({ bucket: deps.bucket, key: media.storageKey });
    if (!s3Result) return null;

    // Derive bundle name from the archive title (strip extension)
    const baseName = path.basename(media.title ?? media.filename, path.extname(media.filename));
    const bundleName = baseName || media.title || "Unpacked Archive";

    // Create the bundle
    const bundle = await deps.bundleRepository.createBundle(userId, bundleName);
    const bundleId = bundle.id;

    // One rules fetch covers every extracted entry.
    const rules = (await deps.listTagRules?.(userId)) ?? [];

    const createdIds: string[] = [];
    const thumbItems: { mediaId: string; userId: string; storageKey: string }[] = [];
    const ocrItems: { mediaId: string; userId: string; storageKey: string }[] = [];
    const thumbUnsupportedIds: string[] = [];
    const textUnsupportedIds: string[] = [];
    let coverCandidateId: string | null = null;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bodyStream = s3Result.body as any;

    for await (const entry of extractArchive(bodyStream, media.mimeType)) {
      const newId = crypto.randomUUID();
      const filename = path.basename(entry.path);
      if (!filename) continue;

      const storageKey = makeStorageKey(userId, newId, filename);

      // Upload extracted file to S3
      await deps.storage.putObject({
        bucket: deps.bucket,
        key: storageKey,
        body: entry.stream,
        contentType: entry.mimeType,
        contentLength: entry.size,
      });

      // Derive title from filename (strip extension)
      const title = path.basename(filename, path.extname(filename)) || filename;

      // Create Media record. The bundle-name tag plus the user's Tag Organizer
      // rules (type:, source:unpacked, …) — all system-applied, recorded AUTO.
      const ruleTags = evaluateRules(rules, {
        filename,
        mimeType: entry.mimeType,
        sizeBytes: entry.size ?? 0,
        ingest: "unpacked",
      });
      const extractedTags = Array.from(
        new Set([coerceTag(bundleName), ...ruleTags].filter((t): t is string => t !== null)),
      );
      await deps.repository.createMedia(
        {
          id: newId,
          userId,
          storageKey,
          filename,
          mimeType: entry.mimeType,
          sizeBytes: entry.size ?? 0,
          title,
          tags: extractedTags,
          sourceState: "READY",
          thumbState: "PENDING",
          textState: "PENDING",
          isExtractedFromArchive: true,
          sourceArchiveId: mediaId,
        },
        { autoTags: extractedTags },
      );

      createdIds.push(newId);
      // Filter by type so unpacking an archive full of e.g. source files doesn't
      // flood the queues with jobs that can only fail (mirrors upload + index).
      if (thumbnailSupported(entry.mimeType)) thumbItems.push({ mediaId: newId, userId, storageKey });
      else thumbUnsupportedIds.push(newId);
      if (ocrSupported(entry.mimeType)) ocrItems.push({ mediaId: newId, userId, storageKey });
      else textUnsupportedIds.push(newId);

      if (!coverCandidateId && isCoverCandidate(entry.mimeType)) {
        coverCandidateId = newId;
      }
    }

    if (createdIds.length === 0) {
      // Nothing was extracted — clean up the empty bundle
      await deps.bundleRepository.deleteBundle(bundleId, userId);
      return null;
    }

    // Enqueue thumbnail + OCR jobs only for compatible types; mark the rest
    // UNSUPPORTED directly so their state is correct without running a doomed job.
    if (thumbItems.length > 0) await enqueueThumbBulk(deps.thumbQueue, thumbItems);
    if (ocrItems.length > 0) await enqueueOcrBulk(deps.ocrQueue, ocrItems);
    if (thumbUnsupportedIds.length > 0) await deps.repository.markThumbUnsupported(thumbUnsupportedIds);
    if (textUnsupportedIds.length > 0) await deps.repository.markTextUnsupported(textUnsupportedIds);

    // Add all items to bundle
    await deps.bundleRepository.addItems(bundleId, userId, createdIds);

    // Set cover
    if (coverCandidateId) {
      await deps.bundleRepository.updateBundle(bundleId, userId, { coverMediaId: coverCandidateId });
    }

    // Link the archive to the bundle (bidirectionally)
    await deps.repository.setLinkedBundle(mediaId, bundleId);
    await deps.bundleRepository.setSourceMedia(bundleId, mediaId);

    // New items exist — tell open library views (relevant for auto-unpack on
    // finalize, where no client action follows to trigger a refetch).
    deps.publishJobUpdate?.({ userId, mediaId: "*", field: "mediaCreated", value: String(createdIds.length) });

    return { bundleId };
  };

  /**
   * Dev escape hatch: stop all background processing by clearing the queue
   * backlog. Index queue first to cut the producer, then the fan-out queues it
   * feeds.
   *
   * Deliberately does NOT obliterate: obliterate({ force }) deletes jobs that
   * are mid-process, so the worker then throws "Missing key for job …
   * moveToDelayed" when it tries to finalise/retry them. Instead we pause (stop
   * pulling new jobs), drain the waiting + delayed backlog, clear terminal jobs,
   * then resume so the queue is usable again. The handful of jobs already active
   * (≤ each worker's concurrency) finish on their own without error.
   */
  const stopIndexWalk = async () => {
    if (!deps.redis) return;
    await signalIndexAbort(deps.redis);
  };

  const abortProcessing = async () => {
    // Stop the producer first: bump the abort epoch so an index walk that's
    // mid-scan in the worker stops adding jobs. Without this, draining only
    // lowers the count for a moment — the active walk immediately refills it.
    if (deps.redis) {
      try {
        await signalIndexAbort(deps.redis);
      } catch {
        // Best-effort; the queue drain below still clears the existing backlog.
      }
    }

    // Only drain the index queue — thumb and ocr jobs already enqueued should
    // finish so thumbnails and text extraction aren't lost mid-walk.
    const targets: [string, Queue<unknown> | undefined][] = [
      ["index", deps.indexQueue as Queue<unknown> | undefined],
    ];
    const cleared: string[] = [];
    await Promise.all(
      targets.map(async ([name, queue]) => {
        if (!queue) return;
        try {
          await queue.pause();
          await queue.drain(true); // remove waiting + delayed (the backlog)
          await queue.clean(0, 0, "failed");
          await queue.clean(0, 0, "completed");
          cleared.push(name);
        } catch {
          // Best-effort for a dev tool — a worker tick can race the drain.
        } finally {
          // Never leave a queue paused, or future indexing/uploads would stall.
          try {
            await queue.resume();
          } catch {
            /* ignore */
          }
        }
      }),
    );
    return { ok: true, cleared };
  };

  // Batch re-queue helpers. Library multi-select is hand-picked (bounded set),
  // so we reuse the single-item methods in a loop rather than the bulk-delete
  // 202+jobId machinery — this keeps the careful per-item stale-job removal,
  // allow-list handling, and unsupported-type no-ops intact. `missing` counts
  // ids the user no longer owns (single-item methods return null).
  const regenerateThumbnailsBatch = async (
    userId: string,
    ids: string[],
    allowedRoots: string[] = [],
  ) => {
    let queued = 0;
    let missing = 0;
    for (const id of ids) {
      const result = await regenerateThumbnail(userId, id, allowedRoots);
      if (result) queued++;
      else missing++;
    }
    return { queued, missing };
  };

  const enqueueTextExtractionBatch = async (
    userId: string,
    ids: string[],
    allowedRoots: string[] = [],
  ) => {
    let queued = 0;
    let missing = 0;
    for (const id of ids) {
      const result = await enqueueTextExtraction(userId, id, { forceOcr: false }, allowedRoots);
      if (result) queued++;
      else missing++;
    }
    return { queued, missing };
  };

  return {
    deleteMedia,
    stopIndexWalk,
    abortProcessing,
    updateMediaMetadata,
    enqueueTextExtraction,
    enqueueTextExtractionBatch,
    cancelTextExtraction,
    getDownloadUrl,
    regenerateThumbnail,
    regenerateThumbnailsBatch,
    prioritizeThumbnail,
    getBulkDownloadItems,
    streamBulkArchive,
    unpackArchive,
    toggleStar,
  };
}
