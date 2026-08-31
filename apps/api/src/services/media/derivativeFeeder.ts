import type { Queue } from "bullmq";
import type { MediaRepository } from "../../repositories/mediaRepository.js";
import type { ThumbJob } from "../../queues/enqueueThumbnail.js";
import { enqueueThumbBulk } from "../../queues/enqueueThumbnail.js";
import type { OcrJobData } from "../ocrProcessingService.js";
import { enqueueTextBulk, textJobId } from "../../queues/enqueueText.js";
import type { HashJobData } from "../../queues/enqueueHash.js";
import { enqueueHashBulk } from "../../queues/enqueueHash.js";

/**
 * Keeps the thumbnail, text and hash queues topped up from the database, each
 * between a low and a high water mark. Indexing writes rows at PENDING and
 * enqueues nothing, so the rows are the backlog and Redis holds only the work
 * in progress.
 */

const DEFAULT_HIGH_WATER = 2000;
const DEFAULT_LOW_WATER = 500;

/** How many rows one claim locks at a time. */
const CLAIM_CHUNK = 500;

const DEFAULT_BUSY_INTERVAL_MS = 1000;
const DEFAULT_IDLE_INTERVAL_MS = 15_000;

type FeederLogger = {
  info: (obj: object, msg: string) => void;
  error: (obj: object, msg: string) => void;
};

export type DerivativeFeederDeps = {
  repository: MediaRepository;
  thumbQueue: Queue<ThumbJob>;
  /** Tier 1 only. OCR jobs are never fed from here. */
  textQueue: Queue<OcrJobData>;
  /** Absent, hashing is not fed. */
  hashQueue?: Queue<HashJobData>;
  /** Read once per tick, because the roots can change during a long backlog. */
  getAllowedRoots: (userId: string) => Promise<string[]>;
  /** Read once per tick, not at start: another process can set the pause flag
   *  while this loop runs. Absent, the feeder never pauses. */
  isPaused?: () => Promise<boolean>;
  logger: FeederLogger;
  highWater?: number;
  lowWater?: number;
  busyIntervalMs?: number;
  idleIntervalMs?: number;
};

export type FeedResult = { thumb: number; text: number; hash: number };

export type DerivativeFeeder = ReturnType<typeof createDerivativeFeeder>;

export function createDerivativeFeeder (deps: DerivativeFeederDeps) {
  const highWater = deps.highWater ?? DEFAULT_HIGH_WATER;
  const lowWater = Math.min(deps.lowWater ?? DEFAULT_LOW_WATER, highWater);
  const busyIntervalMs = deps.busyIntervalMs ?? DEFAULT_BUSY_INTERVAL_MS;
  const idleIntervalMs = deps.idleIntervalMs ?? DEFAULT_IDLE_INTERVAL_MS;

  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  // A slow claim must not overlap the next tick.
  let running = false;

  const queueDepth = async (queue: Queue<ThumbJob> | Queue<OcrJobData> | Queue<HashJobData>): Promise<number> => {
    const counts = await queue.getJobCounts("waiting", "active", "delayed", "prioritized");
    return (counts.waiting ?? 0) + (counts.active ?? 0) + (counts.delayed ?? 0) + (counts.prioritized ?? 0);
  };

  /** Attaches each row's allowed roots, reading preferences once per user. */
  const withAllowedRoots = async <T extends { userId: string }>(rows: T[]) => {
    const rootsByUser = new Map<string, string[]>();
    for (const userId of new Set(rows.map(r => r.userId))) {
      rootsByUser.set(userId, await deps.getAllowedRoots(userId).catch(() => []));
    }
    return rows.map(row => ({ ...row, allowedRoots: rootsByUser.get(row.userId) ?? [] }));
  };

  const feedThumb = async (budget: number): Promise<number> => {
    let fed = 0;
    while (fed < budget) {
      const rows = await deps.repository.claimThumbBatch(Math.min(CLAIM_CHUNK, budget - fed));
      if (rows.length === 0) break;
      try {
        const items = await withAllowedRoots(rows);
        await enqueueThumbBulk(deps.thumbQueue, items.map(row => ({
          mediaId: row.id,
          userId: row.userId,
          storageKey: row.storageKey,
          ...(row.sourcePath ? { sourcePath: row.sourcePath, allowedRoots: row.allowedRoots } : {}),
        })));
      } catch (err) {
        // The claim already stamped these rows as dispatched; without a release
        // they are never fed again.
        await deps.repository.releaseDerivativeClaim("thumb", rows.map(r => r.id))
          .catch(releaseErr => deps.logger.error({ err: releaseErr }, "feeder: failed to release thumb claim"));
        throw err;
      }
      fed += rows.length;
      if (rows.length < CLAIM_CHUNK) break;
    }
    return fed;
  };

  const feedText = async (budget: number): Promise<number> => {
    let fed = 0;
    while (fed < budget) {
      const rows = await deps.repository.claimTextBatch(Math.min(CLAIM_CHUNK, budget - fed));
      if (rows.length === 0) break;
      try {
        const items = await withAllowedRoots(rows);
        await enqueueTextBulk(deps.textQueue, items.map(row => ({
          mediaId: row.id,
          userId: row.userId,
          storageKey: row.storageKey,
          ...(row.sourcePath ? { allowedRoots: row.allowedRoots } : {}),
        })));
      } catch (err) {
        await deps.repository.releaseDerivativeClaim("text", rows.map(r => r.id))
          .catch(releaseErr => deps.logger.error({ err: releaseErr }, "feeder: failed to release text claim"));
        throw err;
      }
      fed += rows.length;
      if (rows.length < CLAIM_CHUNK) break;
    }
    return fed;
  };

  const feedHash = async (budget: number): Promise<number> => {
    const hashQueue = deps.hashQueue;
    if (!hashQueue) return 0;
    let fed = 0;
    while (fed < budget) {
      const rows = await deps.repository.claimHashBatch(Math.min(CLAIM_CHUNK, budget - fed));
      if (rows.length === 0) break;
      try {
        const items = await withAllowedRoots(rows);
        await enqueueHashBulk(hashQueue, items.map(row => ({
          mediaId: row.id,
          userId: row.userId,
          storageKey: row.storageKey,
          ...(row.sourcePath ? { sourcePath: row.sourcePath, allowedRoots: row.allowedRoots } : {}),
        })));
      } catch (err) {
        await deps.repository.releaseDerivativeClaim("hash", rows.map(r => r.id))
          .catch(releaseErr => deps.logger.error({ err: releaseErr }, "feeder: failed to release hash claim"));
        throw err;
      }
      fed += rows.length;
      if (rows.length < CLAIM_CHUNK) break;
    }
    return fed;
  };

  /**
   * Moves the named items to the front of the thumbnail queue. Ignores the water
   * marks: the work is bounded by how many ids the caller passes.
   */
  const promoteThumbnails = async (userId: string, mediaIds: string[]): Promise<{ queued: number; reordered: number }> => {
    if (mediaIds.length === 0) return { queued: 0, reordered: 0 };

    const claimed = await deps.repository.claimThumbByIds(userId, mediaIds);
    if (claimed.length > 0) {
      try {
        const items = await withAllowedRoots(claimed);
        await enqueueThumbBulk(deps.thumbQueue, items.map(row => ({
          mediaId: row.id,
          userId: row.userId,
          storageKey: row.storageKey,
          ...(row.sourcePath ? { sourcePath: row.sourcePath, allowedRoots: row.allowedRoots } : {}),
        })), { lifo: true });
      } catch (err) {
        await deps.repository.releaseDerivativeClaim("thumb", claimed.map(r => r.id))
          .catch(releaseErr => deps.logger.error({ err: releaseErr }, "feeder: failed to release promoted thumb claim"));
        throw err;
      }
    }

    const claimedIds = new Set(claimed.map(r => r.id));
    const alreadyDispatched = mediaIds.filter(id => !claimedIds.has(id));
    let reordered = 0;
    for (const id of alreadyDispatched) {
      try {
        const job = await deps.thumbQueue.getJob(id);
        if (!job) continue;
        await job.changePriority({ lifo: true });
        reordered += 1;
      } catch {
        // The job became active or completed between the lookup and the change.
      }
    }

    return { queued: claimed.length, reordered };
  };

  /**
   * Moves the named items to the front of the tier-1 text queue, the way
   * {@link promoteThumbnails} does for thumbnails. Never touches `ocr_queue`:
   * running OCR for one row goes through `enqueueTextExtraction` instead.
   */
  const promoteText = async (userId: string, mediaIds: string[]): Promise<{ queued: number; reordered: number }> => {
    if (mediaIds.length === 0) return { queued: 0, reordered: 0 };

    const claimed = await deps.repository.claimTextByIds(userId, mediaIds);
    if (claimed.length > 0) {
      try {
        const items = await withAllowedRoots(claimed);
        await enqueueTextBulk(deps.textQueue, items.map(row => ({
          mediaId: row.id,
          userId: row.userId,
          storageKey: row.storageKey,
          ...(row.sourcePath ? { allowedRoots: row.allowedRoots } : {}),
        })), { lifo: true });
      } catch (err) {
        await deps.repository.releaseDerivativeClaim("text", claimed.map(r => r.id))
          .catch(releaseErr => deps.logger.error({ err: releaseErr }, "feeder: failed to release promoted text claim"));
        throw err;
      }
    }

    const claimedIds = new Set(claimed.map(r => r.id));
    const alreadyDispatched = mediaIds.filter(id => !claimedIds.has(id));
    let reordered = 0;
    for (const id of alreadyDispatched) {
      try {
        const job = await deps.textQueue.getJob(textJobId(id));
        if (!job) continue;
        await job.changePriority({ lifo: true });
        reordered += 1;
      } catch {
        // The job became active or completed between the lookup and the change.
      }
    }

    return { queued: claimed.length, reordered };
  };

  /** Runs one top-up pass over the three queues. */
  const tick = async (): Promise<FeedResult> => {
    // The pause is checked here, so a direct call to tick() cannot feed past it.
    if (deps.isPaused && await deps.isPaused()) return { thumb: 0, text: 0, hash: 0 };

    const [thumbDepth, textDepth, hashDepth] = await Promise.all([
      queueDepth(deps.thumbQueue),
      queueDepth(deps.textQueue),
      deps.hashQueue ? queueDepth(deps.hashQueue) : Promise.resolve(0),
    ]);

    const thumb = thumbDepth < lowWater ? await feedThumb(highWater - thumbDepth) : 0;
    const text = textDepth < lowWater ? await feedText(highWater - textDepth) : 0;
    const hash = deps.hashQueue && hashDepth < lowWater ? await feedHash(highWater - hashDepth) : 0;

    if (thumb > 0 || text > 0 || hash > 0) {
      deps.logger.info(
        { thumb, text, hash, thumbDepth, textDepth, hashDepth, lowWater, highWater },
        "feeder: topped up derivative queues",
      );
    }
    return { thumb, text, hash };
  };

  const runOnce = async () => {
    if (running || stopped) return;
    running = true;
    let fedSomething = false;
    try {
      // A paused tick returns zeros, so the loop keeps running at the idle
      // interval and picks up a resume on its own.
      const result = await tick();
      fedSomething = result.thumb > 0 || result.text > 0 || result.hash > 0;
    } catch (err) {
      // A failed tick must not stop the loop.
      deps.logger.error({ err }, "feeder: tick failed");
    } finally {
      running = false;
      if (!stopped) {
        timer = setTimeout(() => void runOnce(), fedSomething ? busyIntervalMs : idleIntervalMs);
        timer.unref?.();
      }
    }
  };

  return {
    tick,
    promoteThumbnails,
    promoteText,
    start () {
      if (timer || stopped) return;
      void runOnce();
    },
    /**
     * Runs the next tick now instead of waiting for the current timer. Does
     * nothing while a tick is in flight, or after stop().
     */
    kick () {
      if (stopped || running) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void runOnce(), 0);
      timer.unref?.();
    },
    async stop () {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}
