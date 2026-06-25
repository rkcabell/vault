import fp from "fastify-plugin";
import { Queue } from "bullmq";
import { buildRedisConnection } from "../lib/config/redis.js";
import { MediaRepository } from "../repositories/mediaRepository.js";
import { BundleRepository } from "../repositories/bundleRepository.js";
import { createMediaUploadService } from "../services/media/mediaUploadService.js";
import { createMediaQueryService } from "../services/media/mediaQueryService.js";
import { createMediaReadService } from "../services/media/mediaReadService.js";
import { createMediaActionsService } from "../services/media/mediaActionsService.js";
import { createIndexService } from "../services/media/indexService.js";
import { createDeleteJobService } from "../services/media/deleteJobService.js";
import type { OcrJobData } from "../services/ocrProcessingService.js";
import type { ThumbJob } from "../queues/enqueueThumbnail.js";
import type { UnpackJob } from "../queues/enqueueUnpack.js";
import { UNPACK_QUEUE } from "../queues/enqueueUnpack.js";
import type { IndexJobData } from "../queues/enqueueIndex.js";
import { INDEX_QUEUE } from "../queues/enqueueIndex.js";
import type { DeleteJobData } from "../queues/enqueueDelete.js";
import { DELETE_QUEUE } from "../queues/enqueueDelete.js";

const OCR_QUEUE = process.env.OCR_QUEUE ?? "ocr_queue";
const THUMB_QUEUE = process.env.THUMB_QUEUE ?? "thumb_queue";

type MediaServices = {
  uploadService: ReturnType<typeof createMediaUploadService>;
  queryService: ReturnType<typeof createMediaQueryService>;
  readService: ReturnType<typeof createMediaReadService>;
  actionsService: ReturnType<typeof createMediaActionsService>;
  indexService: ReturnType<typeof createIndexService>;
  deleteService: ReturnType<typeof createDeleteJobService>;
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
    const deleteQueue = new Queue<DeleteJobData>(DELETE_QUEUE, { connection: redisConnection });

    const repository = new MediaRepository(app.prisma);
    const bundleRepository = new BundleRepository(app.prisma);
    const s3Adapter = app.storage;

    const services: MediaServices = {
      uploadService: createMediaUploadService({
        repository,
        s3Adapter,
        bucket: app.config.S3_BUCKET,
        thumbQueue,
        ocrQueue,
        logger: app.log,
      }),
      queryService: createMediaQueryService({ repository, redis: app.redis }),
      readService: createMediaReadService({
        repository,
        s3Adapter,
        bucket: app.config.S3_BUCKET,
        logger: app.log,
        ocrQueue,
      }),
      actionsService: createMediaActionsService({
        repository,
        bundleRepository,
        s3Adapter,
        bucket: app.config.S3_BUCKET,
        ocrQueue,
        thumbQueue,
        unpackQueue,
        indexQueue,
        redis: app.redis,
      }),
      indexService: createIndexService({
        indexQueue,
        logger: app.log,
      }),
      deleteService: createDeleteJobService({
        deleteQueue,
        logger: app.log,
        redis: app.redis,
      }),
    };

    app.decorate("mediaServices", services);

    app.addHook("onClose", async () => {
      await Promise.allSettled([
        ocrQueue.close(),
        thumbQueue.close(),
        unpackQueue.close(),
        indexQueue.close(),
        deleteQueue.close(),
      ]);
    });
  },
  { name: "mediaServices" },
);
