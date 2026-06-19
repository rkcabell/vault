import type { PrismaClient } from "@prisma/client";
import type { StorageAdapter } from "../adapters/storage/types.js";
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
  storage: StorageAdapter;
  bucket: string;
  allowedRoots?: string[];
  enqueueOcr: OcrProcessingDeps["enqueueOcr"];
  logger?: OcrProcessingDeps["logger"];
  queueName?: string;
  sleep?: OcrProcessingDeps["sleep"];
  textDeps?: OcrProcessingDeps["textDeps"];
  publishJobUpdate?: OcrProcessingDeps["publishJobUpdate"];
};

export async function processOcrJob (deps: OcrDeps, data: OcrJobData) {
  const logger = deps.logger ?? createLogger("ocr-test");
  const serviceDeps: OcrProcessingDeps = {
    mediaRepository: new MediaRepository(deps.prisma),
    documentRepository: new DocumentRepository(deps.prisma),
    storage: deps.storage,
    bucket: deps.bucket,
    allowedRoots: deps.allowedRoots,
    enqueueOcr: deps.enqueueOcr,
    logger,
    queueName: deps.queueName ?? process.env.OCR_QUEUE ?? "ocr_queue",
    sleep: deps.sleep,
    textDeps: deps.textDeps,
    publishJobUpdate: deps.publishJobUpdate,
  };
  return processOcrJobInternal(serviceDeps, data);
}

export {
  createOcrProcessor,
  isTransientError,
  type OcrJobData,
  type OcrProcessingDeps,
};
