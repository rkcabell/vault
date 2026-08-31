import fp from "fastify-plugin";
import { Queue } from "bullmq";
import { buildRedisConnection } from "../lib/config/redis.js";
import { MediaRepository } from "../repositories/mediaRepository.js";
import { createDerivativeFeeder, type DerivativeFeeder } from "../services/media/derivativeFeeder.js";
import { isDerivativesPaused } from "../lib/media/derivativePause.js";
import type { ThumbJob } from "../queues/enqueueThumbnail.js";
import type { OcrJobData } from "../services/ocrProcessingService.js";
import { TEXT_QUEUE } from "../queues/enqueueText.js";
import type { HashJobData } from "../queues/enqueueHash.js";
import { HASH_QUEUE } from "../queues/enqueueHash.js";

/**
 * Starts the feeder that keeps the thumbnail, text and hash queues topped up
 * from the database backlog. It runs in the API process because it must run
 * exactly once: the worker containers scale to replicas and the API does not.
 * Two feeders would corrupt nothing, but the ceiling on each queue would
 * quietly double.
 *
 * DERIVATIVE_FEED_ENABLED=false stops all derivative work. The backlog waits in
 * the database until it is turned back on.
 */

const THUMB_QUEUE = process.env.THUMB_QUEUE ?? "thumb_queue";

declare module "fastify" {
  interface FastifyInstance {
    /** Undefined when DERIVATIVE_FEED_ENABLED=false — treat as "off", not a failure. */
    derivativeFeeder?: DerivativeFeeder;
  }
}

export default fp(
  async app => {
    if (process.env.DERIVATIVE_FEED_ENABLED === "false") {
      app.log.warn({}, "derivative feeder disabled (DERIVATIVE_FEED_ENABLED=false): thumbnails and text will not be generated");
      return;
    }

    const connection = buildRedisConnection(app.config.REDIS_URL);
    const thumbQueue = new Queue<ThumbJob>(THUMB_QUEUE, { connection });
    const textQueue = new Queue<OcrJobData>(TEXT_QUEUE, { connection });
    const hashQueue = new Queue<HashJobData>(HASH_QUEUE, { connection });

    const feeder = createDerivativeFeeder({
      repository: new MediaRepository(app.prisma),
      thumbQueue,
      textQueue,
      hashQueue,
      getAllowedRoots: async userId =>
        (await app.preferencesService.getPreferences(userId)).indexAllowedRoots,
      isPaused: () => isDerivativesPaused(app.redis),
      logger: app.log,
      highWater: parseEnvNumber("DERIVATIVE_FEED_HIGH_WATER"),
      lowWater: parseEnvNumber("DERIVATIVE_FEED_LOW_WATER"),
      busyIntervalMs: parseEnvNumber("DERIVATIVE_FEED_BUSY_INTERVAL_MS"),
      idleIntervalMs: parseEnvNumber("DERIVATIVE_FEED_IDLE_INTERVAL_MS"),
    });

    app.decorate("derivativeFeeder", feeder);

    feeder.start();
    app.log.info({ thumbQueue: THUMB_QUEUE, textQueue: TEXT_QUEUE, hashQueue: HASH_QUEUE }, "derivative feeder started");

    app.addHook("onClose", async () => {
      await feeder.stop();
      await Promise.allSettled([thumbQueue.close(), textQueue.close(), hashQueue.close()]);
    });
  },
  { name: "derivativeFeeder", dependencies: ["prisma", "preferencesService", "redis"] },
);

function parseEnvNumber (name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}
