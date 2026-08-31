import type { Queue } from "bullmq";
import type { OcrJobData } from "../ocrProcessingService.js";
import type { MediaRepository } from "../../repositories/mediaRepository.js";
import type { BundleRepository } from "../../repositories/bundleRepository.js";
import type { StorageAdapter } from "../../adapters/storage/types.js";
import type { ThumbJob } from "../../queues/enqueueThumbnail.js";
import { computeThumbKey } from "../../queues/enqueueThumbnail.js";
import { textJobId, TEXT_JOB_OPTIONS } from "../../queues/enqueueText.js";
import { enqueueOcrBulk, enqueueOcrJob, OCR_PRIORITY_USER } from "../../queues/enqueueOcr.js";
import { normalizeTags } from "../../lib/tags/normalizeTags.js";
import { ocrSupported, thumbnailSupported } from "../../lib/media/processingSupport.js";

/**
 * Changes one media item: deleting it, editing its title and tags, starring it,
 * and re-running its text extraction or its thumbnail.
 */

const MAX_PRESIGNED_SECONDS = 600;

/** Bounds on a single "Extract all" press. */
const EXTRACT_ALL_DEFAULT_LIMIT = 5000;
const EXTRACT_ALL_MAX_LIMIT = 20_000;
const EXTRACT_ALL_CHUNK = 250;

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
  /** Tier 1 — native pdf.js / plain-text reads. */
  textQueue: Queue<OcrJobData>;
  /** Tier 2 — ocrmypdf/Tesseract. Only user-forced extraction and the
   *  `background` sweep add jobs here. */
  ocrQueue: Queue<OcrJobData>;
  thumbQueue: Queue<ThumbJob>;
  /** Publishes a media event, so open library views drop the deleted item. */
  publishJobUpdate?: (update: { userId: string; mediaId: string; field: string; value: string }) => void;
};

export function createMediaActionsService (deps: MediaActionsDeps) {
  /**
   * Removes this item's text job from both tiers. The two queues share a job id
   * ({@link textJobId}) in separate key spaces, and BullMQ drops an add for an
   * id that still exists, so clearing one tier alone leaves the next enqueue
   * doing nothing. An active job cannot be removed, and is left to finish.
   */
  const removeTextJobs = async (mediaId: string) => {
    const jobId = textJobId(mediaId);
    await Promise.allSettled([
      deps.textQueue.getJob(jobId).then(job => job?.remove()),
      deps.ocrQueue.getJob(jobId).then(job => job?.remove()),
    ]);
  };

  const deleteMedia = async (userId: string, id: string) => {
    const media = await deps.repository.findMediaKeys(userId, id);
    if (!media) return null;

    // Vault never deletes a source file on the user's own drive. Only a managed
    // original is removed from storage.
    if (!media.sourcePath && media.storageKey) {
      await deps.storage.deleteIfPresent({ bucket: deps.bucket, key: media.storageKey });
    }
    if (media.thumbnailKey) {
      await deps.storage.deleteIfPresent({ bucket: deps.bucket, key: media.thumbnailKey });
    }

    await deps.repository.deleteMedia(id);

    await deps.bundleRepository.clearCoverMedia(id);

    // Removing the jobs keeps the queues' failed counts accurate.
    await Promise.allSettled([
      removeTextJobs(id),
      deps.thumbQueue.getJob(id).then(job => job?.remove().catch(() => {})),
    ]);

    // Other open library views learn of the removal only from this event.
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

    // Normalized here as well as at the HTTP edge, so no caller of this service
    // can store a raw tag.
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

    if (!ocrSupported(media.mimeType ?? "")) {
      await deps.repository.markTextUnsupported([id]);
      return { ok: true, queued: false };
    }

    // BullMQ drops an add while a completed or failed job still holds the id.
    await removeTextJobs(media.id);

    // PENDING is set before the enqueue: the worker only writes state for a row
    // already at PENDING or NEEDS_OCR, so a job picked up in the gap would have
    // its own completion rejected. A row already at UNSUPPORTED refuses the
    // change, and is reported as not queued.
    const queued = await deps.repository.setTextStatePending(id);
    if (!queued) return { ok: true, queued: false };

    // A row at NEEDS_OCR has already had the native pass find no text in it, so
    // a request to extract its text can only mean tier 2.
    const forceOcr = options.forceOcr ?? media.textState === "NEEDS_OCR";

    const jobData = {
      mediaId: media.id,
      userId,
      storageKey: media.storageKey,
      title: media.title,
      language: options.language,
      rotation: options.rotation,
      // The worker re-validates the path against `allowedRoots` and holds no
      // list of its own, so the caller's snapshot travels with the job.
      ...(media.sourcePath ? { allowedRoots } : {}),
    };

    // A forced job runs Tesseract for minutes and belongs on the OCR pool. An
    // unforced job sent there would wait behind that pool's backlog instead.
    if (forceOcr) {
      await enqueueOcrJob(deps.ocrQueue, jobData, { priority: OCR_PRIORITY_USER });
    } else {
      await deps.textQueue.add("text", { ...jobData, forceOcr: false }, {
        ...TEXT_JOB_OPTIONS,
        // The user is waiting on this one, so it skips the batch warm-up delay.
        delay: 0,
        jobId: textJobId(media.id),
        priority: OCR_PRIORITY_USER,
      });
    }

    return { ok: true, queued: true };
  };

  const cancelTextExtraction = async (userId: string, id: string) => {
    const media = await deps.repository.findForTextJob(userId, id);
    if (!media) return null;

    await removeTextJobs(media.id);

    await deps.repository.setTextState(media.id, "ERROR");

    return { ok: true };
  };

  const getDownloadUrl = async (userId: string, id: string) => {
    const media = await deps.repository.findStorageKey(userId, id);
    if (!media) return null;

    // A source file on the user's drive sits outside storage, so it is served
    // through the same-origin proxy route, which authenticates by cookie.
    if (media.sourcePath) {
      return { url: `/api/media/${id}/source` };
    }

    if (!media.storageKey) {
      // media_source_xor makes this unreachable for a well-formed row.
      throw new Error(`Media ${id} has neither sourcePath nor storageKey`);
    }

    const url = await deps.storage.presignGet({
      bucket: deps.bucket,
      key: media.storageKey,
      expiresSeconds: MAX_PRESIGNED_SECONDS,
    });

    return { url };
  };

  const regenerateThumbnail = async (userId: string, id: string, allowedRoots: string[] = []) => {
    const media = await deps.repository.findMediaKeys(userId, id);
    if (!media) return null;

    // Editing a watched file triggers this, so a type the worker cannot render
    // must not be queued again.
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
        // Regenerate means a fresh render, not a copy of a duplicate's thumbnail.
        noReuse: true,
        // The allow-list snapshot travels with the job; see `enqueueTextExtraction`.
        ...(media.sourcePath ? { sourcePath: media.sourcePath, allowedRoots } : {}),
      },
      { jobId: `thumb-regen-${id}-${Date.now()}`, attempts: 3, backoff: { type: "exponential", delay: 2000 }, removeOnFail: true, removeOnComplete: true },
    );

    return { ok: true };
  };

  /**
   * Moves a waiting thumbnail job ahead of the backlog. Does nothing when the
   * job is gone or already active.
   *
   * BullMQ ranks an unprioritized job above every job that carries a priority,
   * and thumbnail jobs are added unprioritized, so setting a numeric priority
   * would move this item behind the backlog instead.
   */
  const prioritizeThumbnail = async (id: string) => {
    try {
      const job = await deps.thumbQueue.getJob(id);
      if (!job) return { ok: false };
      await job.changePriority({ lifo: true });
      return { ok: true };
    } catch {
      // The job became active or completed between the lookup and the change.
      return { ok: false };
    }
  };

  /** Toggles the star on an item. Returns the new starred state, or null when
   *  the item is not the user's. */
  const toggleStar = async (userId: string, id: string): Promise<boolean | null> => {
    return deps.repository.toggleStar(id, userId);
  };

  // These loop over the single-item methods, which keeps their stale-job removal
  // and unsupported-type handling. `missing` counts ids the user no longer owns.
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

  /**
   * Queues OCR for the rows the native pass found no text in. Stops at `limit`
   * and returns how many are `remaining`, because each job runs for minutes.
   * Rows are claimed in batches, so two presses at once take disjoint sets.
   */
  const extractAllScannedText = async (
    userId: string,
    allowedRoots: string[] = [],
    limit = EXTRACT_ALL_DEFAULT_LIMIT,
  ) => {
    const cap = Math.max(0, Math.min(limit, EXTRACT_ALL_MAX_LIMIT));
    let queued = 0;

    while (queued < cap) {
      const rows = await deps.repository.claimNeedsOcrBatch(
        userId,
        Math.min(EXTRACT_ALL_CHUNK, cap - queued),
      );
      if (rows.length === 0) break;

      // A retained job under this id would make the add a silent no-op.
      await Promise.all(rows.map(row => removeTextJobs(row.id)));

      await enqueueOcrBulk(
        deps.ocrQueue,
        rows.map(row => ({
          mediaId: row.id,
          userId,
          storageKey: row.storageKey,
          title: row.title,
          // The allow-list snapshot travels with the job; see `enqueueTextExtraction`.
          ...(row.sourcePath ? { sourcePath: row.sourcePath, allowedRoots } : {}),
        })),
        { priority: OCR_PRIORITY_USER },
      );

      queued += rows.length;
      if (rows.length < EXTRACT_ALL_CHUNK) break; // backlog exhausted
    }

    return { queued, remaining: await deps.repository.countNeedsOcr(userId) };
  };

  return {
    deleteMedia,
    updateMediaMetadata,
    enqueueTextExtraction,
    enqueueTextExtractionBatch,
    extractAllScannedText,
    cancelTextExtraction,
    getDownloadUrl,
    regenerateThumbnail,
    regenerateThumbnailsBatch,
    prioritizeThumbnail,
    toggleStar,
  };
}
