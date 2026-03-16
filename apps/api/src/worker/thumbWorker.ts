import type { PrismaClient } from "@prisma/client";
import type { S3Client } from "@aws-sdk/client-s3";
import { MediaRepository } from "../repositories/mediaRepository.js";
import {
  createThumbProcessor,
  processThumb as processThumbInternal,
  sanitizeThumbError,
  type ThumbJob,
  type ThumbDeps as ServiceThumbDeps,
} from "../services/thumb/thumbnailService.js";
import { createLogger } from "../lib/logger.js";

export type ThumbDeps = {
  prisma: PrismaClient;
  s3: S3Client;
  bucket: string;
  logger?: ServiceThumbDeps["logger"];
  queueName?: string;
  publishJobUpdate?: ServiceThumbDeps["publishJobUpdate"];
};

export async function processThumb (deps: ThumbDeps, job: ThumbJob) {
  const logger = deps.logger ?? createLogger("thumb-test");
  const serviceDeps: ServiceThumbDeps = {
    prismaMedia: new MediaRepository(deps.prisma),
    s3: deps.s3,
    bucket: deps.bucket,
    logger,
    queueName: deps.queueName ?? process.env.THUMB_QUEUE ?? "thumb_queue",
    publishJobUpdate: deps.publishJobUpdate,
  };
  return processThumbInternal(serviceDeps, job);
}

export { createThumbProcessor, sanitizeThumbError, type ThumbJob, type ServiceThumbDeps as ThumbServiceDeps };
