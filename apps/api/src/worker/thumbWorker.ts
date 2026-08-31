/**
 * Runs a thumbnail job in a worker process, assembling what the thumbnail
 * service needs out of the raw database and storage handles a worker holds.
 */
import type { PrismaClient } from "@prisma/client";
import type { StorageAdapter } from "../adapters/storage/types.js";
import { MediaRepository } from "../repositories/mediaRepository.js";
import {
  createThumbProcessor,
  processThumb as processThumbInternal,
  sanitizeThumbError,
  type ThumbDeps as ServiceThumbDeps,
} from "../services/thumb/thumbnailService.js";
import type { ThumbJob } from "../queues/enqueueThumbnail.js";
import { createLogger } from "../lib/logger.js";

export type ThumbDeps = {
  prisma: PrismaClient;
  storage: StorageAdapter;
  bucket: string;
  allowedRoots?: string[];
  logger?: ServiceThumbDeps["logger"];
  queueName?: string;
  publishJobUpdate?: ServiceThumbDeps["publishJobUpdate"];
};

/** Renders the thumbnail for one job and records the outcome on the item's row. */
export async function processThumb (deps: ThumbDeps, job: ThumbJob) {
  const logger = deps.logger ?? createLogger("thumb-test");
  const serviceDeps: ServiceThumbDeps = {
    prismaMedia: new MediaRepository(deps.prisma),
    storage: deps.storage,
    bucket: deps.bucket,
    allowedRoots: deps.allowedRoots,
    logger,
    queueName: deps.queueName ?? process.env.THUMB_QUEUE ?? "thumb_queue",
    publishJobUpdate: deps.publishJobUpdate,
  };
  return processThumbInternal(serviceDeps, job);
}

export { createThumbProcessor, sanitizeThumbError, type ThumbJob, type ServiceThumbDeps as ThumbServiceDeps };
