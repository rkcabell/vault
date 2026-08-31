import fp from "fastify-plugin";
import { Queue } from "bullmq";
import { buildRedisConnection } from "../lib/config/redis.js";
import { MediaRepository } from "../repositories/mediaRepository.js";
import { BundleRepository } from "../repositories/bundleRepository.js";
import { TagRuleRepository } from "../repositories/tagRuleRepository.js";
import { createIngestService } from "../services/media/ingestService.js";
import { createOrganizeJobService } from "../services/media/organizeJobService.js";
import { createMediaQueryService } from "../services/media/mediaQueryService.js";
import { createMediaReadService } from "../services/media/mediaReadService.js";
import { createMediaActionsService } from "../services/media/mediaActionsService.js";
import { createArchiveService } from "../services/media/archiveService.js";
import { createJobControlService } from "../services/media/jobControlService.js";
import { createIndexService } from "../services/media/indexService.js";
import { createReconcileService } from "../services/media/reconcileService.js";
import { createDeleteJobService } from "../services/media/deleteJobService.js";
import { createDedupService } from "../services/media/dedupService.js";
import type { OcrJobData } from "../services/ocrProcessingService.js";
import type { ThumbJob } from "../queues/enqueueThumbnail.js";
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
import { OCR_QUEUE } from "../queues/enqueueOcr.js";

/**
 * Builds every media service the routes use, along with the queue handles they
 * share. One connection per queue serves the whole process, and all of them are
 * closed when the app closes.
 */

const THUMB_QUEUE = process.env.THUMB_QUEUE ?? "thumb_queue";

type MediaServices = {
  ingestService: ReturnType<typeof createIngestService>;
  queryService: ReturnType<typeof createMediaQueryService>;
  readService: ReturnType<typeof createMediaReadService>;
  actionsService: ReturnType<typeof createMediaActionsService>;
  archiveService: ReturnType<typeof createArchiveService>;
  jobControlService: ReturnType<typeof createJobControlService>;
  indexService: ReturnType<typeof createIndexService>;
  reconcileService: ReturnType<typeof createReconcileService>;
  deleteService: ReturnType<typeof createDeleteJobService>;
  organizeService: ReturnType<typeof createOrganizeJobService>;
  dedupService: ReturnType<typeof createDedupService>;
};

/** Every queue this process holds a handle to, keyed by the name the UI shows.
 *  The jobs routes read depths from these rather than opening a Redis client of
 *  their own on every poll. */
export type JobQueues = Record<string, Queue<unknown>>;

declare module "fastify" {
  interface FastifyInstance {
    mediaServices: MediaServices;
    jobQueues: JobQueues;
  }
}

export default fp(
  async app => {
    const redisConnection = buildRedisConnection(app.config.REDIS_URL);
    const textQueue = new Queue<OcrJobData>(TEXT_QUEUE, { connection: redisConnection });
    const ocrQueue = new Queue<OcrJobData>(OCR_QUEUE, { connection: redisConnection });
    const thumbQueue = new Queue<ThumbJob>(THUMB_QUEUE, { connection: redisConnection });
    const unpackQueue = new Queue<UnpackJob>(UNPACK_QUEUE, { connection: redisConnection });
    const indexQueue = new Queue<IndexJobData>(INDEX_QUEUE, { connection: redisConnection });
    const reconcileQueue = new Queue<ReconcileJobData>(RECONCILE_QUEUE, { connection: redisConnection });
    const deleteQueue = new Queue<DeleteJobData>(DELETE_QUEUE, { connection: redisConnection });
    const organizeQueue = new Queue<OrganizeJobData>(ORGANIZE_QUEUE, { connection: redisConnection });
    const hashQueue = new Queue<HashJobData>(HASH_QUEUE, { connection: redisConnection });

    const repository = new MediaRepository(app.prisma);
    const bundleRepository = new BundleRepository(app.prisma);
    const tagRuleRepository = new TagRuleRepository(app.prisma);
    const listTagRules = (userId: string) => tagRuleRepository.listEnabled(userId);
    const getAutoTagOnIngest = async (userId: string) =>
      (await app.preferencesService.getPreferences(userId)).autoTagOnIngest;
    const storage = app.storage;

    // Publishes on the shared redis client, on the same channel the workers use.
    // The queueEvents plugin relays it into the SSE stream, so a change made
    // here reaches open views the same way a worker's does.
    const publishJobUpdate = (update: { userId: string; mediaId: string; field: string; value: string }) => {
      app.redis
        .publish(
          `media-events:${update.userId}`,
          JSON.stringify({ mediaId: update.mediaId, field: update.field, value: update.value }),
        )
        .catch(err => app.log.warn({ err }, "failed to publish media event"));
    };

    const services: MediaServices = {
      ingestService: createIngestService({
        mediaRepository: repository,
        logger: app.log,
        getIngestConfig: async (userId: string) => {
          const prefs = await app.preferencesService.getPreferences(userId);
          return { folderPath: prefs.ingestFolderPath, allowedRoots: prefs.indexAllowedRoots };
        },
        listTagRules,
        getAutoTagOnIngest,
        publishJobUpdate,
      }),
      queryService: createMediaQueryService({ repository, redis: app.redis }),
      readService: createMediaReadService({
        repository,
        storage,
        bucket: app.config.STORAGE_BUCKET,
        logger: app.log,
        ocrQueue,
        textQueue,
      }),
      actionsService: createMediaActionsService({
        repository,
        bundleRepository,
        storage,
        bucket: app.config.STORAGE_BUCKET,
        textQueue,
        ocrQueue,
        thumbQueue,
        publishJobUpdate,
      }),
      archiveService: createArchiveService({
        repository,
        bundleRepository,
        storage,
        bucket: app.config.STORAGE_BUCKET,
        unpackQueue,
        logger: app.log,
        listTagRules,
        getAutoTagOnIngest,
        publishJobUpdate,
      }),
      jobControlService: createJobControlService({
        indexQueue,
        reconcileQueue,
        redis: app.redis,
      }),
      indexService: createIndexService({
        indexQueue,
        logger: app.log,
      }),
      reconcileService: createReconcileService({
        reconcileQueue,
        logger: app.log,
      }),
      deleteService: createDeleteJobService({
        deleteQueue,
        logger: app.log,
        redis: app.redis,
      }),
      organizeService: createOrganizeJobService({
        organizeQueue,
        logger: app.log,
      }),
      dedupService: createDedupService({
        repository,
        logger: app.log,
      }),
    };

    app.decorate("mediaServices", services);
    app.decorate("jobQueues", {
      index: indexQueue,
      reconcile: reconcileQueue,
      thumb: thumbQueue,
      text: textQueue,
      ocr: ocrQueue,
      hash: hashQueue,
      unpack: unpackQueue,
      organize: organizeQueue,
      delete: deleteQueue,
    } as JobQueues);

    app.addHook("onClose", async () => {
      await Promise.allSettled([
        textQueue.close(),
        ocrQueue.close(),
        thumbQueue.close(),
        unpackQueue.close(),
        indexQueue.close(),
        reconcileQueue.close(),
        deleteQueue.close(),
        organizeQueue.close(),
        hashQueue.close(),
      ]);
    });
  },
  { name: "mediaServices" },
);
