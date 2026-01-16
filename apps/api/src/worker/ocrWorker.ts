import type { PrismaClient } from "@prisma/client";
import type { S3Client } from "@aws-sdk/client-s3";
import { MediaRepository } from "../repositories/mediaRepository.js";
import { DocumentRepository } from "../repositories/documentRepository.js";
import {
  createOcrProcessor,
  processOcrJob as processOcrJobInternal,
  type OcrJobData,
  isTransientError,
  type OcrProcessingDeps,
} from "../services/ocrProcessingService.js";
import { createLogger } from "../lib/logger.js";

export type OcrDeps = {
  prisma: PrismaClient;
  s3: S3Client;
  bucket: string;
  enqueueOcr: OcrProcessingDeps["enqueueOcr"];
  logger?: OcrProcessingDeps["logger"];
  queueName?: string;
  sleep?: OcrProcessingDeps["sleep"];
};

export async function processOcrJob (deps: OcrDeps, data: OcrJobData) {
  const logger = deps.logger ?? createLogger("ocr-test");
  const serviceDeps: OcrProcessingDeps = {
    mediaRepository: new MediaRepository(deps.prisma),
    documentRepository: new DocumentRepository(deps.prisma),
    s3: deps.s3,
    bucket: deps.bucket,
    enqueueOcr: deps.enqueueOcr,
    logger,
    queueName: deps.queueName ?? process.env.OCR_QUEUE ?? "ocr_queue",
    sleep: deps.sleep,
  };
  return processOcrJobInternal(serviceDeps, data);
}

export {
  createOcrProcessor,
  isTransientError,
  type OcrJobData,
  type OcrProcessingDeps,
};
