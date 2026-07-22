import type { Processor } from "bullmq";
import type { UnpackJob } from "../queues/enqueueUnpack.js";
import type { MediaRepository } from "../repositories/mediaRepository.js";
import type { BundleRepository } from "../repositories/bundleRepository.js";
import type { StorageAdapter } from "../adapters/storage/types.js";
import type { Queue } from "bullmq";
import type { OcrJobData } from "../services/ocrProcessingService.js";
import type { ThumbJob } from "../queues/enqueueThumbnail.js";
import type { TagRuleInput } from "../lib/tags/rules/evaluateRules.js";
import { createMediaActionsService } from "../services/media/mediaActionsService.js";

type UnpackWorkerDeps = {
  mediaRepository: MediaRepository;
  bundleRepository: BundleRepository;
  storage: StorageAdapter;
  bucket: string;
  ocrQueue: Queue<OcrJobData>;
  thumbQueue: Queue<ThumbJob>;
  /** The user's enabled Tag Organizer rules, applied to unpacked entries. */
  listTagRules?: (userId: string) => Promise<TagRuleInput[]>;
  logger: { info: (obj: object, msg: string) => void; error: (obj: object, msg: string) => void };
  publishJobUpdate?: (update: { userId: string; mediaId: string; field: string; value: string }) => void;
};

export function createUnpackProcessor (deps: UnpackWorkerDeps): Processor<UnpackJob> {
  const actionsService = createMediaActionsService({
    repository: deps.mediaRepository,
    bundleRepository: deps.bundleRepository,
    storage: deps.storage,
    bucket: deps.bucket,
    ocrQueue: deps.ocrQueue,
    thumbQueue: deps.thumbQueue,
    listTagRules: deps.listTagRules,
    publishJobUpdate: deps.publishJobUpdate,
  });

  return async job => {
    const { mediaId, userId } = job.data;
    deps.logger.info({ mediaId, userId }, "unpack job started");

    const result = await actionsService.unpackArchive(userId, mediaId);

    if (!result) {
      deps.logger.info({ mediaId, userId }, "unpack: no entries extracted or media not found");
      return;
    }

    if (result === "already-linked") {
      deps.logger.info({ mediaId, userId }, "unpack: archive already linked to a bundle");
      return;
    }

    if (result === "not-archive") {
      deps.logger.info({ mediaId, userId }, "unpack: media is not a recognised archive type");
      return;
    }

    deps.logger.info({ mediaId, userId, bundleId: result.bundleId }, "unpack job completed");
  };
}
