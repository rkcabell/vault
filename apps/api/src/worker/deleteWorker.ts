/**
 * Deletes many items in the background, a chunk at a time, so the request that
 * asked for it does not have to wait.
 */
import type { Job, Processor } from "bullmq";
import type { DeleteJobData, DeleteJobFilters, DeleteJobProgress } from "../queues/enqueueDelete.js";
import type { MediaDeletionRow } from "../repositories/mediaRepository.js";

type DeleteLogger = {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
};

/** Filter shape the repository expects (job filters + the resolved userId). */
type RepoFilters = DeleteJobFilters & { userId: string };

/** Everything the worker touches, passed in so it can be run against test doubles. */
type DeleteWorkerDeps = {
  mediaRepository: {
    countMediaForDeletion: (filters: RepoFilters) => Promise<number>;
    listMediaForDeletion: (filters: RepoFilters, limit: number) => Promise<MediaDeletionRow[]>;
    findMediaForDeletionByIds: (userId: string, ids: string[]) => Promise<MediaDeletionRow[]>;
    deleteMediaByIds: (ids: string[], userId: string) => Promise<number>;
    reconcileTagCounts: (userId: string) => Promise<void>;
  };
  bundleRepository: {
    clearCoverMediaForIds: (userId: string, mediaIds: string[]) => Promise<void>;
  };
  storage: {
    deleteIfPresent: (input: { bucket: string; key: string }) => Promise<void>;
  };
  bucket: string;
  logger: DeleteLogger;
  /** Publishes a media event to Redis so open library views refresh without a
   *  manual reload. Optional — tests and minimal wiring may omit it. */
  publishJobUpdate?: (update: { userId: string; mediaId: string; field: string; value: string }) => void;
  /** Reads the current abort epoch (see lib/media/deleteAbort). Defaults to "never abort". */
  readAbortEpoch?: () => Promise<number>;
  /** How many rows to delete per chunk (tests use a small value). */
  chunkSize?: number;
  /** How many files may be removed from storage at once, so the process does not run out of open file handles. */
  storageConcurrency?: number;
};

/**
 * Rows handled per pass.
 *
 * Large enough that the database does little work per row, small enough that
 * progress is reported often and a request to stop is noticed quickly.
 */
const CHUNK_SIZE = 500;
const STORAGE_CONCURRENCY = 50;

// Runs `fn` over `items` with at most `limit` of them in progress at once.
async function mapLimit<T> (items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx]);
    }
  });
  await Promise.all(workers);
}

export function createDeleteProcessor (deps: DeleteWorkerDeps): Processor<DeleteJobData> {
  const chunkSize = deps.chunkSize ?? CHUNK_SIZE;
  const storageConcurrency = deps.storageConcurrency ?? STORAGE_CONCURRENCY;

  /**
   * Deletes one chunk of items and returns how many rows went.
   *
   * A file that was indexed where it sits belongs to the user and is left
   * alone; only files Vault itself wrote are removed.
   */
  const deleteChunk = async (userId: string, rows: MediaDeletionRow[]): Promise<number> => {
    // Drop the DB rows first. If the row delete throws, storage is left intact —
    // a retry is clean. Unlinking storage first would, on a DB failure, orphan
    // rows that point at already-deleted objects (broken thumbnails/downloads).
    const ids = rows.map(r => r.id);
    const deleted = await deps.mediaRepository.deleteMediaByIds(ids, userId);
    await deps.bundleRepository.clearCoverMediaForIds(userId, ids);

    const storageOps: { bucket: string; key: string }[] = [];
    for (const row of rows) {
      // In-place indexed items (sourcePath set) live on the user's drive — Vault
      // must never delete the source. Managed originals are removed from storage.
      if (!row.sourcePath && row.storageKey) storageOps.push({ bucket: deps.bucket, key: row.storageKey });
      if (row.thumbnailKey) storageOps.push({ bucket: deps.bucket, key: row.thumbnailKey });
    }
    // Storage failures are non-fatal — once the rows are gone a stray object is
    // harmless (no row references it), so a failed unlink shouldn't fail the chunk.
    await mapLimit(storageOps, storageConcurrency, op =>
      deps.storage.deleteIfPresent(op).catch(() => {}),
    );

    return deleted;
  };

  return async (job: Job<DeleteJobData>) => {
    const { userId, ids, filters } = job.data;
    const readAbortEpoch = deps.readAbortEpoch ?? (async () => 0);
    // Capture the epoch at start; a later bump means this job must stop.
    const startEpoch = await readAbortEpoch();
    const isAborted = async () => (await readAbortEpoch()) > startEpoch;

    const useIds = Array.isArray(ids) && ids.length > 0;
    const repoFilters: RepoFilters = { ...(filters ?? {}), userId };

    const total = useIds ? ids!.length : await deps.mediaRepository.countMediaForDeletion(repoFilters);
    const progress: DeleteJobProgress = { total, deleted: 0, failed: 0 };
    await job.updateProgress(progress);
    deps.logger.info({ userId, total, mode: useIds ? "ids" : "filter" }, "bulk delete started");

    let aborted = false;
    let didDelete = false;

    try {
    if (useIds) {
      for (let i = 0; i < ids!.length; i += chunkSize) {
        if (await isAborted()) { aborted = true; break; }
        const chunkIds = ids!.slice(i, i + chunkSize);
        const rows = await deps.mediaRepository.findMediaForDeletionByIds(userId, chunkIds);
        if (rows.length === 0) continue;
        try {
          progress.deleted += await deleteChunk(userId, rows);
          didDelete = true;
          // Per-chunk event so a long delete empties open views progressively
          // (the client debounces its refetch).
          deps.publishJobUpdate?.({ userId, mediaId: "*", field: "mediaDeleted", value: String(progress.deleted) });
        } catch (err) {
          progress.failed += chunkIds.length;
          deps.logger.warn({ userId, err }, "delete chunk failed");
        }
        await job.updateProgress(progress);
      }
    } else {
      // Filter mode: deleted rows drop out of the filter, so re-select until empty.
      while (true) {
        if (await isAborted()) { aborted = true; break; }
        const rows = await deps.mediaRepository.listMediaForDeletion(repoFilters, chunkSize);
        if (rows.length === 0) break;
        try {
          progress.deleted += await deleteChunk(userId, rows);
          didDelete = true;
          deps.publishJobUpdate?.({ userId, mediaId: "*", field: "mediaDeleted", value: String(progress.deleted) });
        } catch (err) {
          // A failing chunk would otherwise be re-selected forever — bail out.
          progress.failed += rows.length;
          deps.logger.warn({ userId, err }, "delete chunk failed");
          break;
        }
        await job.updateProgress(progress);
      }
    }

    } finally {
      // One authoritative pass fixes every Tag.count against committed data.
      // Runs in a finally so an unexpected throw mid-job can't leave counts
      // permanently drifted from the chunks that already committed.
      if (didDelete) {
        await deps.mediaRepository.reconcileTagCounts(userId).catch(err =>
          deps.logger.warn({ userId, err }, "tag count reconcile failed"),
        );
        // Tell open library views the list changed. Published after the counts
        // are reconciled so the refetch they trigger sees consistent data.
        deps.publishJobUpdate?.({
          userId,
          mediaId: "*",
          field: "mediaDeleted",
          value: String(progress.deleted),
        });
      }
    }

    if (aborted) {
      progress.aborted = true;
      await job.updateProgress(progress);
      deps.logger.warn({ userId, ...progress }, "bulk delete aborted");
      return progress;
    }

    deps.logger.info({ userId, ...progress }, "bulk delete completed");
    return progress;
  };
}
