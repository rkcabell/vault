import fp from "fastify-plugin";
import { Queue } from "bullmq";
import { buildRedisConnection } from "../lib/config/redis.js";
import { MediaRepository } from "../repositories/mediaRepository.js";
import { BundleRepository } from "../repositories/bundleRepository.js";
import { TagRuleRepository } from "../repositories/tagRuleRepository.js";
import { createMediaUploadService } from "../services/media/mediaUploadService.js";
import { createOrganizeJobService } from "../services/media/organizeJobService.js";
import { createMediaQueryService } from "../services/media/mediaQueryService.js";
import { createMediaReadService } from "../services/media/mediaReadService.js";
import { createMediaActionsService } from "../services/media/mediaActionsService.js";
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

const OCR_QUEUE = process.env.OCR_QUEUE ?? "ocr_queue";
const THUMB_QUEUE = process.env.THUMB_QUEUE ?? "thumb_queue";

type MediaServices = {
  uploadService: ReturnType<typeof createMediaUploadService>;
  queryService: ReturnType<typeof createMediaQueryService>;
  readService: ReturnType<typeof createMediaReadService>;
  actionsService: ReturnType<typeof createMediaActionsService>;
  indexService: ReturnType<typeof createIndexService>;
  reconcileService: ReturnType<typeof createReconcileService>;
  deleteService: ReturnType<typeof createDeleteJobService>;
  organizeService: ReturnType<typeof createOrganizeJobService>;
  dedupService: ReturnType<typeof createDedupService>;
};

declare module "fastify" {
  interface FastifyInstance {
    mediaServices: MediaServices;
  }
}

export default fp(
  async app => {
    const redisConnection = buildRedisConnection(app.config.REDIS_URL);
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
    const storage = app.storage;

    // Publish media events on the shared redis client; the queueEvents plugin's
    // subscriber bridges them back into the SSE stream (same channel the
    // workers publish on, so API-side mutations refresh open views too).
    const publishJobUpdate = (update: { userId: string; mediaId: string; field: string; value: string }) => {
      app.redis
        .publish(
          `media-events:${update.userId}`,
          JSON.stringify({ mediaId: update.mediaId, field: update.field, value: update.value }),
        )
        .catch(err => app.log.warn({ err }, "failed to publish media event"));
    };

    const services: MediaServices = {
      uploadService: createMediaUploadService({
        repository,
        storage,
        bucket: app.config.STORAGE_BUCKET,
        thumbQueue,
        ocrQueue,
        hashQueue,
        logger: app.log,
        listTagRules,
        publishJobUpdate,
      }),
      queryService: createMediaQueryService({ repository, redis: app.redis }),
      readService: createMediaReadService({
        repository,
        storage,
        bucket: app.config.STORAGE_BUCKET,
        logger: app.log,
        ocrQueue,
      }),
      actionsService: createMediaActionsService({
        repository,
        bundleRepository,
        storage,
        bucket: app.config.STORAGE_BUCKET,
        ocrQueue,
        thumbQueue,
        unpackQueue,
        indexQueue,
        redis: app.redis,
        listTagRules,
        publishJobUpdate,
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
        hashQueue,
        // Lazy per-call read: the preferences plugin registers separately, and
        // roots must be current at scan time (they gate in-place source reads).
        getAllowedRoots: async userId =>
          (await app.preferencesService.getPreferences(userId)).indexAllowedRoots,
        logger: app.log,
      }),
    };

    app.decorate("mediaServices", services);

    app.addHook("onClose", async () => {
      await Promise.allSettled([
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
