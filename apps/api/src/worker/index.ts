import "dotenv/config";

import path from "node:path";
import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";

import { prisma } from "@vault/db";
import { createOcrProcessor, type OcrJobData } from "./ocrWorker.js";
import { createThumbProcessor, sanitizeThumbError, type ThumbJob } from "./thumbWorker.js";
import { createUnpackProcessor } from "./unpackWorker.js";
import { createIndexProcessor } from "./indexWorker.js";
import { createReconcileProcessor } from "./reconcileWorker.js";
import { createDeleteProcessor } from "./deleteWorker.js";
import { createOrganizeProcessor } from "./organizeWorker.js";
import { createHashProcessor } from "./hashWorker.js";
import { createIndexWatcher } from "./indexWatcher.js";
import { createMediaActionsService } from "../services/media/mediaActionsService.js";
import { readIndexAbortEpoch } from "../lib/media/indexAbort.js";
import { readDeleteAbortEpoch } from "../lib/media/deleteAbort.js";
import { enqueueReconcile, reconcileJobId } from "../queues/enqueueReconcile.js";
import { MediaRepository } from "../repositories/mediaRepository.js";
import { BundleRepository } from "../repositories/bundleRepository.js";
import { TagRuleRepository } from "../repositories/tagRuleRepository.js";
import { MediaMetadataRepository } from "../repositories/mediaMetadataRepository.js";
import { DocumentRepository } from "../repositories/documentRepository.js";
import { PreferencesRepository } from "../repositories/preferencesRepository.js";
import { PreferencesService } from "../services/preferencesService.js";
import { buildRedisConnection } from "../lib/config/redis.js";
import { createLogger } from "../lib/logger.js";
import { TextJobError } from "../lib/text/processTextJob.js";
import { markStalledJobs } from "../services/stallDetectionService.js";
import { createWorkerStorage, workerBucket, workerAllowedRoots } from "./storageFromEnv.js";
import type { UnpackJob } from "../queues/enqueueUnpack.js";
import { UNPACK_QUEUE } from "../queues/enqueueUnpack.js";
import type { IndexJobData } from "../queues/enqueueIndex.js";
import { INDEX_QUEUE } from "../queues/enqueueIndex.js";
import type { ReconcileJobData } from "../queues/enqueueReconcile.js";
import { RECONCILE_QUEUE } from "../queues/enqueueReconcile.js";
import type { DeleteJobData } from "../queues/enqueueDelete.js";
import { DELETE_QUEUE } from "../queues/enqueueDelete.js";
import type { OrganizeJobData } from "../queues/enqueueOrganize.js";
import { ORGANIZE_QUEUE } from "../queues/enqueueOrganize.js";
import type { HashJobData } from "../queues/enqueueHash.js";
import { HASH_QUEUE } from "../queues/enqueueHash.js";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const BUCKET = workerBucket();

const OCR_QUEUE = process.env.OCR_QUEUE ?? "ocr_queue";
const THUMB_QUEUE = process.env.THUMB_QUEUE ?? "thumb_queue";
const _UNPACK_QUEUE = UNPACK_QUEUE;
const _INDEX_QUEUE = INDEX_QUEUE;
const OCR_LOCK_DURATION_MS = parseEnvNumber("OCR_LOCK_DURATION_MS", 30 * 60 * 1000);
const OCR_LOCK_RENEW_MS = parseEnvNumber(
  "OCR_LOCK_RENEW_MS",
  Math.max(30 * 1000, Math.floor(OCR_LOCK_DURATION_MS / 2)),
);
const OCR_STALLED_INTERVAL_MS = parseEnvNumber("OCR_STALLED_INTERVAL_MS", 60 * 1000);
const STALL_CHECK_INTERVAL_MS = parseEnvNumber("STALL_CHECK_INTERVAL_MS", 10 * 60 * 1000);

// Live in-place indexing: native inotify doesn't propagate across Docker Desktop
// bind mounts, WSL2 /mnt mounts, or network shares — set INDEX_WATCH_POLLING=true
// there. The reconciliation scan is the authoritative backstop regardless.
const INDEX_WATCH_POLLING = process.env.INDEX_WATCH_POLLING === "true";
const INDEX_WATCH_INTERVAL = parseEnvNumber("INDEX_WATCH_INTERVAL", 2000);
// Master switch for automatic in-place indexing (live watcher + reconcile loop).
// Default on; set INDEX_AUTO=false to index only on explicit manual scans.
const INDEX_AUTO = process.env.INDEX_AUTO !== "false";
const INDEX_RECONCILE_INTERVAL_MS = parseEnvNumber("INDEX_RECONCILE_INTERVAL_MS", 60 * 60 * 1000);
// Reconcile every allowed root at boot. On by default, because boot is the one
// moment we know the library may have drifted: the watcher sees nothing while
// the process is down, so a start is exactly when "what changed while I was
// away?" needs answering. Set INDEX_RECONCILE_ON_BOOT=false to opt out.
const INDEX_RECONCILE_ON_BOOT = process.env.INDEX_RECONCILE_ON_BOOT !== "false";
// ...but skip the boot sweep for a root reconciled more recently than this. In
// dev, tsx watch restarts the worker on every file save; without the cooldown
// each save would kick off a full-root walk. A real restart after downtime is
// always older than the cooldown, so the case that matters still runs.
const INDEX_RECONCILE_BOOT_COOLDOWN_MS = parseEnvNumber("INDEX_RECONCILE_BOOT_COOLDOWN_MS", 30 * 60 * 1000);
// How often to look for missing items that have outlived the grace period, and
// how many to delete per pass. The cap keeps one sweep from stalling the worker
// after a large drive was unmounted for a week.
const MISSING_SWEEP_INTERVAL_MS = parseEnvNumber("MISSING_SWEEP_INTERVAL_MS", 6 * 60 * 60 * 1000);
const MISSING_SWEEP_LIMIT = parseEnvNumber("MISSING_SWEEP_LIMIT", 500);

async function main () {
  const logger = createLogger("worker");
  const connection = buildRedisConnection(REDIS_URL);

  // Dedicated publish-only client — does not block the BullMQ connection
  const publisher = new IORedis(REDIS_URL);
  publisher.on("error", err => logger.warn({ err }, "publisher redis error"));

  const publishJobUpdate = (update: { userId: string; mediaId: string; field: string; value: string }) => {
    publisher
      .publish(`media-events:${update.userId}`, JSON.stringify({ mediaId: update.mediaId, field: update.field, value: update.value }))
      .catch(err => logger.warn({ err }, "failed to publish job update"));
  };

  const storage = createWorkerStorage();

  const mediaRepository = new MediaRepository(prisma);
  const bundleRepository = new BundleRepository(prisma);
  const metadataRepository = new MediaMetadataRepository(prisma);
  const documentRepository = new DocumentRepository(prisma);
  const preferencesService = new PreferencesService(new PreferencesRepository(prisma));
  const tagRuleRepository = new TagRuleRepository(prisma);
  const listTagRules = (userId: string) => tagRuleRepository.listEnabled(userId);

  const ocrLogger = logger.child({ queue: OCR_QUEUE, jobName: "ocr" });
  const thumbLogger = logger.child({ queue: THUMB_QUEUE, jobName: "thumb" });

  const ocrQueue = new Queue<OcrJobData>(OCR_QUEUE, { connection });
  const thumbQueue = new Queue<ThumbJob>(THUMB_QUEUE, { connection });
  const indexQueue = new Queue<IndexJobData>(_INDEX_QUEUE, { connection });
  const reconcileQueue = new Queue<ReconcileJobData>(RECONCILE_QUEUE, { connection });
  const deleteQueue = new Queue<DeleteJobData>(DELETE_QUEUE, { connection });
  const hashQueue = new Queue<HashJobData>(HASH_QUEUE, { connection });

  const allowedRoots = workerAllowedRoots();

  const ocrWorker = new Worker<OcrJobData>(
    OCR_QUEUE,
    createOcrProcessor({
      mediaRepository,
      documentRepository,
      storage: storage,
      bucket: BUCKET,
      allowedRoots,
      enqueueOcr: async (data, opts) => ocrQueue.add("ocr", data, opts),
      logger: ocrLogger,
      queueName: OCR_QUEUE,
      publishJobUpdate,
    }),
    {
      connection,
      concurrency: 4,
      lockDuration: OCR_LOCK_DURATION_MS,
      lockRenewTime: OCR_LOCK_RENEW_MS,
      stalledInterval: OCR_STALLED_INTERVAL_MS,
    },
  );

  const thumbWorker = new Worker<ThumbJob>(
    THUMB_QUEUE,
    createThumbProcessor({
      prismaMedia: mediaRepository,
      metadataRepository,
      preferencesService,
      storage: storage,
      bucket: BUCKET,
      allowedRoots,
      logger: thumbLogger,
      queueName: THUMB_QUEUE,
      publishJobUpdate,
    }),
    { connection, concurrency: 4 },
  );

  const unpackLogger = logger.child({ queue: _UNPACK_QUEUE, jobName: "unpack" });

  const unpackWorker = new Worker<UnpackJob>(
    _UNPACK_QUEUE,
    createUnpackProcessor({
      mediaRepository,
      bundleRepository,
      storage,
      bucket: BUCKET,
      ocrQueue,
      thumbQueue,
      listTagRules,
      logger: unpackLogger,
      publishJobUpdate,
    }),
    { connection, concurrency: 2 },
  );

  const indexLogger = logger.child({ queue: _INDEX_QUEUE, jobName: "index" });

  const indexWorker = new Worker<IndexJobData>(
    _INDEX_QUEUE,
    createIndexProcessor({
      mediaRepository,
      thumbQueue,
      ocrQueue,
      hashQueue,
      listTagRules,
      logger: indexLogger,
      publishJobUpdate,
      // Read the abort epoch off the publish client (a plain GET); the dev abort
      // endpoint bumps it so an in-flight walk stops adding jobs.
      readAbortEpoch: () => readIndexAbortEpoch(publisher),
    }),
    {
      connection,
      concurrency: 1, // one walk at a time; per-file work fans out to thumb/ocr
      // maxStalledCount 0: a walk left "active" by a mid-scan worker death must
      // fail, not respawn — the default re-run restarts a full-root walk nobody
      // asked for, which exploded the queues on every restart. Re-scan to resume.
      maxStalledCount: 0,
    },
  );

  const reconcileLogger = logger.child({ queue: RECONCILE_QUEUE, jobName: "reconcile" });

  const reconcileWorker = new Worker<ReconcileJobData>(
    RECONCILE_QUEUE,
    createReconcileProcessor({
      mediaRepository,
      thumbQueue,
      ocrQueue,
      hashQueue,
      listTagRules,
      logger: reconcileLogger,
      publishJobUpdate,
      // Same epoch the index walk reads, so the one stop control cancels
      // whichever of the two is running.
      readAbortEpoch: () => readIndexAbortEpoch(publisher),
    }),
    {
      connection,
      concurrency: 1, // one sweep at a time; per-file work fans out to thumb/ocr/hash
      // A sweep left "active" by a mid-run worker death must fail, not respawn:
      // the default re-run restarts a full-root walk nobody asked for. Re-running
      // is always safe, so resuming is a button press away.
      maxStalledCount: 0,
    },
  );

  const deleteLogger = logger.child({ queue: DELETE_QUEUE, jobName: "delete" });

  const deleteWorker = new Worker<DeleteJobData>(
    DELETE_QUEUE,
    createDeleteProcessor({
      mediaRepository,
      bundleRepository,
      storage,
      bucket: BUCKET,
      logger: deleteLogger,
      publishJobUpdate,
      // Read the abort epoch off the publish client (a plain GET); the delete
      // abort endpoint bumps it so an in-flight delete stops between chunks.
      readAbortEpoch: () => readDeleteAbortEpoch(publisher),
    }),
    {
      connection,
      concurrency: 1, // one bulk delete at a time; the per-chunk work is set-based
      // A delete whose worker dies mid-run leaves the job "active". A partial
      // delete is resumable by re-running, so a stalled job must fail, not respawn.
      maxStalledCount: 0,
    },
  );

  const hashLogger = logger.child({ queue: HASH_QUEUE, jobName: "hash" });

  const hashWorker = new Worker<HashJobData>(
    HASH_QUEUE,
    createHashProcessor({
      mediaRepository,
      preferencesService,
      storage,
      bucket: BUCKET,
      logger: hashLogger,
    }),
    { connection, concurrency: 2 }, // streaming, IO-bound; keep it light
  );

  const organizeLogger = logger.child({ queue: ORGANIZE_QUEUE, jobName: "organize" });

  const organizeWorker = new Worker<OrganizeJobData>(
    ORGANIZE_QUEUE,
    createOrganizeProcessor({
      mediaRepository,
      tagRuleRepository,
      getIndexRoots: async userId =>
        (await preferencesService.getPreferences(userId)).indexAllowedRoots,
      logger: organizeLogger,
      publishJobUpdate,
    }),
    {
      connection,
      concurrency: 1, // one retro run at a time; per-row work is cheap
      // A partial organize run is resumable by re-running (it only adds missing
      // tags), so a stalled job must fail, not respawn.
      maxStalledCount: 0,
    },
  );

  ocrWorker.on("ready", () => ocrLogger.info({ queue: OCR_QUEUE }, "worker ready"));
  thumbWorker.on("ready", () => thumbLogger.info({ queue: THUMB_QUEUE }, "worker ready"));
  unpackWorker.on("ready", () => unpackLogger.info({ queue: _UNPACK_QUEUE }, "worker ready"));
  indexWorker.on("ready", () => indexLogger.info({ queue: _INDEX_QUEUE }, "worker ready"));
  reconcileWorker.on("ready", () => reconcileLogger.info({ queue: RECONCILE_QUEUE }, "worker ready"));
  deleteWorker.on("ready", () => deleteLogger.info({ queue: DELETE_QUEUE }, "worker ready"));
  organizeWorker.on("ready", () => organizeLogger.info({ queue: ORGANIZE_QUEUE }, "worker ready"));
  hashWorker.on("ready", () => hashLogger.info({ queue: HASH_QUEUE }, "worker ready"));

  // Live in-place indexing: a single chokidar watcher across all users' allowed
  // roots. mediaActionsService gives the watcher a delete path that also cleans
  // thumbnails/S3 and queue jobs; it never deletes an in-place source.
  const watchLogger = logger.child({ component: "index-watcher" });
  const mediaActions = createMediaActionsService({
    repository: mediaRepository,
    bundleRepository,
    storage,
    bucket: BUCKET,
    ocrQueue,
    thumbQueue,
    listTagRules,
    publishJobUpdate,
  });
  const indexWatcher = createIndexWatcher(
    {
      mediaRepository,
      thumbQueue,
      ocrQueue,
      hashQueue,
      listTagRules,
      publishJobUpdate,
      deleteMedia: (userId, id) => mediaActions.deleteMedia(userId, id),
      regenerateThumbnail: (userId, id, roots) => mediaActions.regenerateThumbnail(userId, id, roots),
      logger: watchLogger,
    },
    () => preferencesService.listIndexConfigs(),
    { polling: INDEX_WATCH_POLLING, interval: INDEX_WATCH_INTERVAL },
  );
  // Automatic indexing (live watcher + reconcile) is gated behind INDEX_AUTO so a
  // dev machine can index only on explicit manual scans. The watcher object is
  // created above regardless (cheap — chokidar only starts on .start()).
  if (INDEX_AUTO) {
    await indexWatcher.start().catch(err => watchLogger.error({ err }, "index watcher failed to start"));
  } else {
    watchLogger.warn({}, "automatic indexing disabled (INDEX_AUTO=false): no watcher, no reconcile — manual scans still run");
  }

  // Reconciliation backstop: catches everything the watcher cannot see —
  // inotify is unreliable on bind mounts and network shares, and while the
  // process is down it sees nothing at all. Enqueues one sweep per allowed
  // root; the work itself lives in reconcileWorker, which is also what the
  // Settings button and the boot run drive, so all three behave identically.
  const scheduleLogger = logger.child({ component: "index-reconcile" });
  const runReconcile = async (opts: { cooldownMs?: number } = {}) => {
    const configs = await preferencesService.listIndexConfigs();
    for (const config of configs) {
      for (const root of config.allowedRoots) {
        const rootPath = path.resolve(root);
        // Boot passes a cooldown so a dev restart storm doesn't launch a
        // full-root walk per save. The interval run passes none.
        if (opts.cooldownMs !== undefined) {
          const previous = await reconcileQueue.getJob(reconcileJobId(config.userId, rootPath));
          const finishedOn = previous?.finishedOn;
          if (finishedOn && Date.now() - finishedOn < opts.cooldownMs) {
            scheduleLogger.info(
              { userId: config.userId, root: rootPath, finishedOn },
              "reconcile skipped at boot (ran recently)",
            );
            continue;
          }
        }
        await enqueueReconcile(reconcileQueue, {
          userId: config.userId,
          rootPath,
          allowedRoots: config.allowedRoots,
          ignoreHidden: config.ignoreHidden,
          blacklistExtensions: config.blacklistExtensions,
          excludeFolders: config.excludeFolders,
          skipNonContent: config.skipNonContent,
          // Background sweeps yield to anything the user asked for directly
          // (BullMQ treats a higher number as lower priority).
        }, { priority: 10 }).catch(err => scheduleLogger.warn({ err, root: rootPath }, "reconcile enqueue failed"));
      }
    }
  };

  // The only place an in-place row is deleted for real. Items whose file has
  // been gone longer than the user's grace period are genuine deletions rather
  // than moves or unmounted drives, so their rows finally go.
  const sweepLogger = logger.child({ component: "missing-sweeper" });
  const runSweep = async () => {
    const configs = await preferencesService.listIndexConfigs();
    for (const config of configs) {
      const cutoff = new Date(Date.now() - config.missingFileGraceDays * 86_400_000);
      const ids = await mediaRepository.findMissingBefore(config.userId, cutoff, MISSING_SWEEP_LIMIT);
      let swept = 0;
      for (const id of ids) {
        const ok = await mediaActions.deleteMedia(config.userId, id)
          .then(() => true)
          .catch(err => { sweepLogger.warn({ err, id }, "sweep delete failed"); return false; });
        if (ok) swept += 1;
      }
      if (swept > 0) {
        sweepLogger.info(
          { userId: config.userId, count: swept, graceDays: config.missingFileGraceDays },
          "swept missing items past grace period",
        );
      }
    }
  };
  const runReconcileSafe = (opts?: { cooldownMs: number }) =>
    runReconcile(opts).catch(err => scheduleLogger.error({ err }, "reconciliation failed"));
  // Only schedule reconcile when automatic indexing is enabled. Within that, the
  // boot run stays separately gated by INDEX_RECONCILE_ON_BOOT.
  let reconcileInterval: NodeJS.Timeout | undefined;
  let sweepInterval: NodeJS.Timeout | undefined;
  if (INDEX_AUTO) {
    if (INDEX_RECONCILE_ON_BOOT) void runReconcileSafe({ cooldownMs: INDEX_RECONCILE_BOOT_COOLDOWN_MS });
    else scheduleLogger.info({}, "reconcile-on-boot disabled (INDEX_RECONCILE_ON_BOOT=false)");
    reconcileInterval = setInterval(() => void runReconcileSafe(), INDEX_RECONCILE_INTERVAL_MS);
    // Never on boot: a restart right after a drive went offline should not be
    // what triggers deletions. The first sweep is one interval away.
    sweepInterval = setInterval(
      () => void runSweep().catch(err => sweepLogger.error({ err }, "missing sweep failed")),
      MISSING_SWEEP_INTERVAL_MS,
    );
  }

  // Run stall detection once on startup (catches records left over from a previous crash),
  // then on a recurring interval.
  const stallLogger = logger.child({ component: "stall-detection" });
  const runStallCheck = () =>
    markStalledJobs(mediaRepository, stallLogger).catch(err =>
      stallLogger.error({ err }, "stall detection failed"),
    );
  void runStallCheck();
  const stallInterval = setInterval(runStallCheck, STALL_CHECK_INTERVAL_MS);

  ocrWorker.on("failed", async (job, err) => {
    const errorCode =
      err instanceof TextJobError
        ? err.code
        : err instanceof Error && err.name
          ? err.name
          : "UNKNOWN_ERROR";
    const attempts = job?.opts?.attempts ?? 1;
    const isFinal = job ? (job.attemptsMade ?? 0) >= attempts : true;

    // Mark ERROR on all final failures, including transient ones (e.g. repeated network
    // timeouts). Without this, a job that exhausts all retries on transient errors stays
    // at PENDING indefinitely — exactly the stall case stall detection is meant to catch.
    if (job?.data?.mediaId && isFinal) {
      try {
        await mediaRepository.setTextState(job.data.mediaId, "ERROR");
        if (job.data.userId) {
          publishJobUpdate({ userId: job.data.userId, mediaId: job.data.mediaId, field: "textState", value: "ERROR" });
        }
        ocrLogger.error(
          {
            jobName: "ocr",
            queue: OCR_QUEUE,
            jobId: job?.id ?? "unknown",
            mediaId: job.data.mediaId,
            userId: job.data.userId ?? null,
            durationMs: job?.processedOn ? Date.now() - job.processedOn : undefined,
            errorCode,
          },
          "ocr job failed (marked ERROR)",
        );
      } catch (updateErr) {
        ocrLogger.error(
          {
            jobName: "ocr",
            queue: OCR_QUEUE,
            jobId: job?.id ?? "unknown",
            mediaId: job.data.mediaId,
            userId: job.data.userId ?? null,
            durationMs: job?.processedOn ? Date.now() - job.processedOn : undefined,
            errorCode: "TEXT_STATE_UPDATE_FAILED",
            err: updateErr,
          },
          "failed to mark textState ERROR",
        );
      }
    }

    ocrLogger.error(
      {
        jobName: "ocr",
        queue: OCR_QUEUE,
        jobId: job?.id ?? "unknown",
        mediaId: job?.data?.mediaId ?? "unknown",
        userId: job?.data?.userId ?? null,
        attempt: job?.attemptsMade ?? 0,
        durationMs: job?.processedOn ? Date.now() - job.processedOn : undefined,
        errorCode,
        err,
      },
      "ocr job failed",
    );
  });

  thumbWorker.on("failed", async (job, err) => {
    const msg = err instanceof Error ? err.message : String(err);
    const attempts = job?.opts?.attempts ?? 1;
    const isFinal = job ? (job.attemptsMade ?? 0) >= attempts : true;
    const reason = sanitizeThumbError(err);

    if (job?.data?.mediaId && isFinal) {
      try {
        await mediaRepository.setThumbFailed(job.data.mediaId, reason);
        publishJobUpdate({ userId: job.data.userId, mediaId: job.data.mediaId, field: "thumbState", value: "FAILED" });
      } catch (updateErr) {
        thumbLogger.error(
          {
            jobName: "thumb",
            queue: THUMB_QUEUE,
            jobId: job?.id ?? "unknown",
            mediaId: job.data.mediaId,
            userId: job.data.userId ?? null,
            durationMs: job?.processedOn ? Date.now() - job.processedOn : undefined,
            errorCode: "THUMB_STATE_UPDATE_FAILED",
            err: updateErr,
          },
          "failed to mark thumbState FAILED",
        );
      }
    }

    thumbLogger.error(
      {
        jobName: "thumb",
        queue: THUMB_QUEUE,
        jobId: job?.id ?? "unknown",
        mediaId: job?.data?.mediaId ?? "unknown",
        userId: job?.data?.userId ?? null,
        attempt: job?.attemptsMade ?? 0,
        durationMs: job?.processedOn ? Date.now() - job.processedOn : undefined,
        errorCode: msg,
        err,
      },
      "thumb job failed",
    );
  });

  ocrWorker.on("error", err =>
    ocrLogger.error(
      {
        jobName: "ocr",
        queue: OCR_QUEUE,
        errorCode: err instanceof Error && err.name ? err.name : "WORKER_ERROR",
        err,
      },
      "worker error",
    ),
  );
  thumbWorker.on("error", err =>
    thumbLogger.error(
      {
        jobName: "thumb",
        queue: THUMB_QUEUE,
        errorCode: err instanceof Error && err.name ? err.name : "WORKER_ERROR",
        err,
      },
      "worker error",
    ),
  );

  unpackWorker.on("failed", (job, err) => {
    unpackLogger.error(
      {
        jobName: "unpack",
        queue: _UNPACK_QUEUE,
        jobId: job?.id ?? "unknown",
        mediaId: job?.data?.mediaId ?? "unknown",
        err,
      },
      "unpack job failed",
    );
  });

  unpackWorker.on("error", err =>
    unpackLogger.error({ jobName: "unpack", queue: _UNPACK_QUEUE, err }, "worker error"),
  );

  indexWorker.on("failed", (job, err) =>
    indexLogger.error(
      { jobName: "index", queue: _INDEX_QUEUE, jobId: job?.id ?? "unknown", userId: job?.data?.userId ?? null, err },
      "index job failed",
    ),
  );
  indexWorker.on("error", err =>
    indexLogger.error({ jobName: "index", queue: _INDEX_QUEUE, err }, "worker error"),
  );

  reconcileWorker.on("failed", (job, err) =>
    reconcileLogger.error(
      { jobName: "reconcile", queue: RECONCILE_QUEUE, jobId: job?.id ?? "unknown", userId: job?.data?.userId ?? null, err },
      "reconcile job failed",
    ),
  );
  reconcileWorker.on("error", err =>
    reconcileLogger.error({ jobName: "reconcile", queue: RECONCILE_QUEUE, err }, "worker error"),
  );

  deleteWorker.on("failed", (job, err) =>
    deleteLogger.error(
      { jobName: "delete", queue: DELETE_QUEUE, jobId: job?.id ?? "unknown", userId: job?.data?.userId ?? null, err },
      "delete job failed",
    ),
  );
  deleteWorker.on("error", err =>
    deleteLogger.error({ jobName: "delete", queue: DELETE_QUEUE, err }, "worker error"),
  );

  organizeWorker.on("failed", (job, err) =>
    organizeLogger.error(
      { jobName: "organize", queue: ORGANIZE_QUEUE, jobId: job?.id ?? "unknown", userId: job?.data?.userId ?? null, err },
      "organize job failed",
    ),
  );
  organizeWorker.on("error", err =>
    organizeLogger.error({ jobName: "organize", queue: ORGANIZE_QUEUE, err }, "worker error"),
  );

  hashWorker.on("failed", (job, err) =>
    hashLogger.error(
      { jobName: "hash", queue: HASH_QUEUE, jobId: job?.id ?? "unknown", mediaId: job?.data?.mediaId ?? "unknown", userId: job?.data?.userId ?? null, err },
      "hash job failed",
    ),
  );
  hashWorker.on("error", err =>
    hashLogger.error({ jobName: "hash", queue: HASH_QUEUE, err }, "worker error"),
  );

  logger.info({ queues: [OCR_QUEUE, THUMB_QUEUE, _UNPACK_QUEUE, _INDEX_QUEUE, RECONCILE_QUEUE, DELETE_QUEUE, ORGANIZE_QUEUE, HASH_QUEUE] }, "worker started");

  const shutdown = async () => {
    logger.info("worker shutting down...");
    clearInterval(stallInterval);
    if (reconcileInterval) clearInterval(reconcileInterval);
    if (sweepInterval) clearInterval(sweepInterval);
    await indexWatcher.close().catch(err => watchLogger.warn({ err }, "index watcher close failed"));
    await Promise.all([ocrWorker.close(), thumbWorker.close(), unpackWorker.close(), indexWorker.close(), reconcileWorker.close(), deleteWorker.close(), organizeWorker.close(), hashWorker.close()]);
    await Promise.allSettled([ocrQueue.close(), thumbQueue.close(), indexQueue.close(), reconcileQueue.close(), deleteQueue.close(), hashQueue.close()]);
    await publisher.quit();
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch(err => {
  const logger = createLogger("worker");
  logger.error({ err }, "worker fatal");
  process.exit(1);
});

function parseEnvNumber (name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}
