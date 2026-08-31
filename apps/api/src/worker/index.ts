/**
 * Entry point for the combined worker, which runs every queue in one process.
 * The split Docker deployment runs text, OCR and thumbnails as their own
 * containers instead, so the concurrencies here are lower: in this process they
 * add up rather than sitting side by side.
 */

import "dotenv/config";

import path from "node:path";
import { Queue, Worker, type JobsOptions } from "bullmq";
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
import { configureSharp } from "./configureSharp.js";
import { readLowMemoryPreference } from "./workerPrefs.js";
import { createMediaActionsService } from "../services/media/mediaActionsService.js";
import { readIndexAbortEpoch } from "../lib/media/indexAbort.js";
import { readDeleteAbortEpoch } from "../lib/media/deleteAbort.js";
import { readReconcileAbortEpoch } from "../lib/media/reconcileAbort.js";
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
import { DEFAULT_PREFERENCES } from "@vault/types";
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
import { TEXT_QUEUE } from "../queues/enqueueText.js";
import { OCR_QUEUE, enqueueOcrJob } from "../queues/enqueueOcr.js";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const BUCKET = workerBucket();

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
// the process is down, so a start is when "what changed while I was away?"
// needs answering. Set INDEX_RECONCILE_ON_BOOT=false to opt out.
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

  // Every queue below shares this one process, so the concurrencies compound
  // rather than sitting side by side as they do in the split Docker containers.
  // Defaults are therefore deliberately lower than ocr.ts / thumb.ts use — but
  // they read the same env vars, so a deployment tunes one set of knobs whether
  // it runs combined or split.
  const lowMemory = process.env.LOW_MEMORY === "true" || process.env.LOW_MEMORY === "1"
    || await readLowMemoryPreference(prisma);
  // Halve everything rather than special-casing individual queues: memory
  // pressure comes from the total number of concurrent subprocesses, not from
  // any one queue's share of them.
  const scale = (n: number) => (lowMemory ? Math.max(1, Math.floor(n / 2)) : n);
  // Tier 1 is IO-bound and spawns nothing, so it gets the large number. Tier 2
  // is one subprocess per slot and gets the small one. Splitting the queues is
  // worth nothing unless each pool is sized for what it does.
  const TEXT_CONCURRENCY = parseEnvNumber("TEXT_CONCURRENCY", scale(8));
  const OCR_CONCURRENCY = parseEnvNumber("OCR_CONCURRENCY", scale(2));
  const THUMB_CONCURRENCY = parseEnvNumber("THUMB_CONCURRENCY", scale(4));
  const UNPACK_CONCURRENCY = parseEnvNumber("UNPACK_CONCURRENCY", scale(2));
  const HASH_CONCURRENCY = parseEnvNumber("HASH_CONCURRENCY", scale(2));
  if (lowMemory) logger.info({}, "low-memory mode: worker concurrencies halved");

  // Runs before any Worker below starts pulling. BullMQ owns parallelism, and
  // libvips must not also spread each pipeline across the cores.
  await configureSharp(logger);

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
  // Every ingest site the worker owns (index scan, watcher, reconcile, unpack)
  // reads this, which is what the "OnIngest" in the preference name asserts.
  const getAutoTagOnIngest = async (userId: string) =>
    (await preferencesService.getPreferences(userId)).autoTagOnIngest;

  const textLogger = logger.child({ queue: TEXT_QUEUE, jobName: "text" });
  const ocrLogger = logger.child({ queue: OCR_QUEUE, jobName: "ocr" });
  const thumbLogger = logger.child({ queue: THUMB_QUEUE, jobName: "thumb" });

  const textQueue = new Queue<OcrJobData>(TEXT_QUEUE, { connection });
  const ocrQueue = new Queue<OcrJobData>(OCR_QUEUE, { connection });
  const thumbQueue = new Queue<ThumbJob>(THUMB_QUEUE, { connection });
  const indexQueue = new Queue<IndexJobData>(_INDEX_QUEUE, { connection });
  const reconcileQueue = new Queue<ReconcileJobData>(RECONCILE_QUEUE, { connection });
  const deleteQueue = new Queue<DeleteJobData>(DELETE_QUEUE, { connection });
  const hashQueue = new Queue<HashJobData>(HASH_QUEUE, { connection });

  const allowedRoots = workerAllowedRoots();

  // One processor drains both tiers; `forceOcr` in the job data decides which
  // half of it runs. The handoff always targets ocrQueue, so a tier-1 job that
  // meets a scan enqueues rather than blocking its slot on Tesseract.
  const textProcessorDeps = {
    mediaRepository,
    documentRepository,
    storage: storage,
    bucket: BUCKET,
    allowedRoots,
    enqueueOcr: async (data: OcrJobData, opts?: JobsOptions) => enqueueOcrJob(ocrQueue, data, opts),
    getOcrMode: async (userId?: string) =>
      userId ? (await preferencesService.getPreferences(userId)).ocrMode : DEFAULT_PREFERENCES.ocrMode,
    getOcrTimeoutCapMinutes: async (userId?: string) =>
      userId ? (await preferencesService.getPreferences(userId)).ocrTimeoutCapMinutes : DEFAULT_PREFERENCES.ocrTimeoutCapMinutes,
    publishJobUpdate,
  };

  const textWorker = new Worker<OcrJobData>(
    TEXT_QUEUE,
    createOcrProcessor({ ...textProcessorDeps, logger: textLogger, queueName: TEXT_QUEUE }),
    // No lock extension: nothing here runs long enough to need it.
    { connection, concurrency: TEXT_CONCURRENCY },
  );

  const ocrWorker = new Worker<OcrJobData>(
    OCR_QUEUE,
    createOcrProcessor({ ...textProcessorDeps, logger: ocrLogger, queueName: OCR_QUEUE }),
    {
      connection,
      concurrency: OCR_CONCURRENCY,
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
    { connection, concurrency: THUMB_CONCURRENCY },
  );

  const unpackLogger = logger.child({ queue: _UNPACK_QUEUE, jobName: "unpack" });

  const unpackWorker = new Worker<UnpackJob>(
    _UNPACK_QUEUE,
    createUnpackProcessor({
      mediaRepository,
      bundleRepository,
      storage,
      bucket: BUCKET,
      listTagRules,
      getAutoTagOnIngest,
      logger: unpackLogger,
      publishJobUpdate,
    }),
    { connection, concurrency: UNPACK_CONCURRENCY },
  );

  const indexLogger = logger.child({ queue: _INDEX_QUEUE, jobName: "index" });

  const indexWorker = new Worker<IndexJobData>(
    _INDEX_QUEUE,
    createIndexProcessor({
      mediaRepository,
      listTagRules,
      getAutoTagOnIngest,
      logger: indexLogger,
      publishJobUpdate,
      // Read off the publish client with a plain GET. The abort endpoint raises
      // it, and a walk already running then stops adding jobs.
      readAbortEpoch: () => readIndexAbortEpoch(publisher),
    }),
    {
      connection,
      concurrency: 1, // one walk at a time; per-file work fans out to thumb/ocr
      // maxStalledCount 0: a walk left active by a worker that died mid-scan has
      // to fail rather than respawn. The default re-run would restart a
      // full-root walk nobody asked for. Scanning again is how to resume.
      maxStalledCount: 0,
    },
  );

  const reconcileLogger = logger.child({ queue: RECONCILE_QUEUE, jobName: "reconcile" });

  const reconcileWorker = new Worker<ReconcileJobData>(
    RECONCILE_QUEUE,
    createReconcileProcessor({
      mediaRepository,
      listTagRules,
      getAutoTagOnIngest,
      logger: reconcileLogger,
      publishJobUpdate,
      // Read the abort epoch off the publish client (a plain GET); the reconcile
      // abort endpoint bumps it so an in-flight sweep stops between ticks.
      readAbortEpoch: () => readReconcileAbortEpoch(publisher),
    }),
    {
      connection,
      concurrency: 1, // one sweep at a time; per-file work fans out to thumb/ocr/hash
      // maxStalledCount 0 — same reason as index_queue above.
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
      // maxStalledCount 0 — as above; a partial delete is resumable by re-running.
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
    { connection, concurrency: HASH_CONCURRENCY }, // streaming, IO-bound; keep it light
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
      // maxStalledCount 0 — as above; a partial run only adds missing tags.
      maxStalledCount: 0,
    },
  );

  textWorker.on("ready", () => textLogger.info({ queue: TEXT_QUEUE }, "worker ready"));
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
  // thumbnails and queue jobs; it never deletes an in-place source.
  const watchLogger = logger.child({ component: "index-watcher" });
  const mediaActions = createMediaActionsService({
    repository: mediaRepository,
    bundleRepository,
    storage,
    bucket: BUCKET,
    textQueue,
    ocrQueue,
    thumbQueue,
    publishJobUpdate,
  });
  const indexWatcher = createIndexWatcher(
    {
      mediaRepository,
      listTagRules,
      getAutoTagOnIngest,
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

  // Catches everything the watcher cannot see. It queues one sweep per allowed
  // root, and reconcileWorker does the work, which is also what the settings
  // button and the boot run drive, so all three behave the same.
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

  // Runs once on startup too, to catch records left over from a previous crash.
  const stallLogger = logger.child({ component: "stall-detection" });
  const runStallCheck = () =>
    markStalledJobs(mediaRepository, stallLogger).catch(err =>
      stallLogger.error({ err }, "stall detection failed"),
    );
  void runStallCheck();
  const stallInterval = setInterval(runStallCheck, STALL_CHECK_INTERVAL_MS);

  // Both text tiers fail the same way and need the same ERROR write, so they
  // share one handler parameterised by which queue reported it.
  const attachTextFailureHandlers = (
    worker: Worker<OcrJobData>,
    queueName: string,
    jobName: string,
    log: typeof ocrLogger,
  ) => {
    worker.on("failed", async (job, err) => {
      const errorCode =
        err instanceof TextJobError
          ? err.code
          : err instanceof Error && err.name
            ? err.name
            : "UNKNOWN_ERROR";
      const attempts = job?.opts?.attempts ?? 1;
      const isFinal = job ? (job.attemptsMade ?? 0) >= attempts : true;
      const base = {
        jobName,
        queue: queueName,
        jobId: job?.id ?? "unknown",
        mediaId: job?.data?.mediaId ?? "unknown",
        userId: job?.data?.userId ?? null,
        durationMs: job?.processedOn ? Date.now() - job.processedOn : undefined,
      };

      // Mark ERROR on all final failures, including transient ones (e.g. repeated network
      // timeouts). Without this, a job that exhausts all retries on transient errors stays
      // at PENDING indefinitely — the stall case stall detection is meant to catch.
      if (job?.data?.mediaId && isFinal) {
        try {
          await mediaRepository.setTextState(job.data.mediaId, "ERROR");
          if (job.data.userId) {
            publishJobUpdate({ userId: job.data.userId, mediaId: job.data.mediaId, field: "textState", value: "ERROR" });
          }
          log.error({ ...base, errorCode }, `${jobName} job failed (marked ERROR)`);
        } catch (updateErr) {
          log.error({ ...base, errorCode: "TEXT_STATE_UPDATE_FAILED", err: updateErr }, "failed to mark textState ERROR");
        }
      }

      log.error({ ...base, attempt: job?.attemptsMade ?? 0, errorCode, err }, `${jobName} job failed`);
    });

    worker.on("error", err =>
      log.error(
        {
          jobName,
          queue: queueName,
          errorCode: err instanceof Error && err.name ? err.name : "WORKER_ERROR",
          err,
        },
        "worker error",
      ),
    );
  };

  attachTextFailureHandlers(textWorker, TEXT_QUEUE, "text", textLogger);
  attachTextFailureHandlers(ocrWorker, OCR_QUEUE, "ocr", ocrLogger);

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

  logger.info({ queues: [TEXT_QUEUE, OCR_QUEUE, THUMB_QUEUE, _UNPACK_QUEUE, _INDEX_QUEUE, RECONCILE_QUEUE, DELETE_QUEUE, ORGANIZE_QUEUE, HASH_QUEUE] }, "worker started");

  const shutdown = async () => {
    logger.info("worker shutting down...");
    clearInterval(stallInterval);
    if (reconcileInterval) clearInterval(reconcileInterval);
    if (sweepInterval) clearInterval(sweepInterval);
    await indexWatcher.close().catch(err => watchLogger.warn({ err }, "index watcher close failed"));
    await Promise.all([textWorker.close(), ocrWorker.close(), thumbWorker.close(), unpackWorker.close(), indexWorker.close(), reconcileWorker.close(), deleteWorker.close(), organizeWorker.close(), hashWorker.close()]);
    await Promise.allSettled([textQueue.close(), ocrQueue.close(), thumbQueue.close(), indexQueue.close(), reconcileQueue.close(), deleteQueue.close(), hashQueue.close()]);
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
