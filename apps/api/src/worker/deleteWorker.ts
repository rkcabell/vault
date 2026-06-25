import type { Job, Processor } from "bullmq";
import type { DeleteJobData, DeleteJobFilters, DeleteJobProgress } from "../queues/enqueueDelete.js";
import type { MediaDeletionRow } from "../repositories/mediaRepository.js";

type DeleteLogger = {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
};

/** Filter shape the repository expects (job filters + the resolved userId). */
type RepoFilters = DeleteJobFilters & { userId: string };

/** Structural deps so the worker is unit-testable with simple fakes (mirrors the
 *  injected-dependency convention used across the services). */
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
  s3Adapter: {
    deleteIfPresent: (input: { bucket: string; key: string }) => Promise<void>;
  };
  bucket: string;
  logger: DeleteLogger;
  /** Reads the current abort epoch (see lib/media/deleteAbort). Defaults to "never abort". */
  readAbortEpoch?: () => Promise<number>;
  /** How many rows to delete per chunk (tests use a small value). */
  chunkSize?: number;
  /** Cap on concurrent storage unlinks per chunk (guards against EMFILE on local FS). */
  storageConcurrency?: number;
};

/** Rows deleted per DB statement / per re-select pass. Large enough that the DB
 *  work is a handful of queries; small enough that progress ticks frequently and
 *  an abort lands promptly. */
const CHUNK_SIZE = 500;
const STORAGE_CONCURRENCY = 50;

/** Run `fn` over `items` with at most `limit` in flight at once. */
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

  /** Delete one chunk: drop the rows set-based, clear any bundle covers pointing
   *  at them, then unlink storage (never the in-place source). Returns rows deleted. */
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
      deps.s3Adapter.deleteIfPresent(op).catch(() => {}),
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

    if (useIds) {
      for (let i = 0; i < ids!.length; i += chunkSize) {
        if (await isAborted()) { aborted = true; break; }
        const chunkIds = ids!.slice(i, i + chunkSize);
        const rows = await deps.mediaRepository.findMediaForDeletionByIds(userId, chunkIds);
        if (rows.length === 0) continue;
        try {
          progress.deleted += await deleteChunk(userId, rows);
          didDelete = true;
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
        } catch (err) {
          // A failing chunk would otherwise be re-selected forever — bail out.
          progress.failed += rows.length;
          deps.logger.warn({ userId, err }, "delete chunk failed");
          break;
        }
        await job.updateProgress(progress);
      }
    }

    // One authoritative pass fixes every Tag.count against committed data.
    if (didDelete) await deps.mediaRepository.reconcileTagCounts(userId);

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
