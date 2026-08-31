import type { Processor } from "bullmq";
import type { UnpackJob } from "../queues/enqueueUnpack.js";
import type { MediaRepository } from "../repositories/mediaRepository.js";
import type { BundleRepository } from "../repositories/bundleRepository.js";
import type { StorageAdapter } from "../adapters/storage/types.js";
import type { TagRuleInput } from "../lib/tags/rules/evaluateRules.js";
import { createArchiveService } from "../services/media/archiveService.js";

/**
 * Unpacks one archive in the background, so a large archive does not hold an
 * HTTP request open.
 */

type UnpackWorkerDeps = {
  mediaRepository: MediaRepository;
  bundleRepository: BundleRepository;
  storage: StorageAdapter;
  bucket: string;
  /** The user's enabled Tag Organizer rules, applied to unpacked entries. */
  listTagRules?: (userId: string) => Promise<TagRuleInput[]>;
  /** The user's `autoTagOnIngest` preference. Off, an unpacked entry carries
   *  only its bundle name. Absent, tagging is enabled. */
  getAutoTagOnIngest?: (userId: string) => Promise<boolean>;
  logger: {
    info: (obj: object, msg: string) => void;
    warn: (obj: unknown, msg: string) => void;
    error: (obj: object, msg: string) => void;
  };
  publishJobUpdate?: (update: { userId: string; mediaId: string; field: string; value: string }) => void;
};

export function createUnpackProcessor (deps: UnpackWorkerDeps): Processor<UnpackJob> {
  // No queue handles: entries are created at PENDING for the feeder, and this
  // process reads unpack_queue rather than adding to it.
  const archiveService = createArchiveService({
    repository: deps.mediaRepository,
    bundleRepository: deps.bundleRepository,
    storage: deps.storage,
    bucket: deps.bucket,
    logger: deps.logger,
    listTagRules: deps.listTagRules,
    getAutoTagOnIngest: deps.getAutoTagOnIngest,
    publishJobUpdate: deps.publishJobUpdate,
  });

  return async job => {
    const { mediaId, userId, allowedRoots } = job.data;
    deps.logger.info({ mediaId, userId }, "unpack job started");

    const result = await archiveService.unpackArchive(userId, mediaId, allowedRoots ?? []);

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
