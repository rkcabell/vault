import crypto from "node:crypto";
import type { Job, Processor } from "bullmq";
import type { StorageAdapter } from "../adapters/storage/types.js";
import { openSourceStream } from "../adapters/storage/openSource.js";
import { tagDuplicatesForHash, type DuplicateTagRepository } from "../services/media/duplicateTag.js";
import type { HashJobData } from "../queues/enqueueHash.js";

/**
 * Hashes a file's contents into `Media.contentHash`. This covers the items the
 * thumbnail worker never hashes: the types it cannot render, and the files too
 * large to load. Bytes are streamed, so memory does not grow with the file.
 */

type HashLogger = {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
};

type HashWorkerDeps = {
  mediaRepository: DuplicateTagRepository & {
    setContentHash: (mediaId: string, hash: string) => Promise<void>;
    setHashState: (mediaId: string, state: "READY" | "FAILED") => Promise<boolean>;
  };
  /** Absent, items are hashed but never tagged as duplicates. */
  preferencesService?: { getPreferences: (userId: string) => Promise<{ detectDuplicates?: boolean }> };
  storage: StorageAdapter;
  bucket: string;
  logger: HashLogger;
};

export function createHashProcessor (deps: HashWorkerDeps): Processor<HashJobData> {
  return async (job: Job<HashJobData>) => {
    const { mediaId, userId, storageKey, sourcePath, allowedRoots } = job.data;

    const res = await openSourceStream({
      storage: deps.storage,
      bucket: deps.bucket,
      storageKey,
      sourcePath,
      allowedRoots: allowedRoots ?? [],
    });
    // The file is gone, and a retry cannot bring it back. FAILED is written now,
    // rather than leaving the row at PENDING for stall detection to find later.
    if (!res) {
      await deps.mediaRepository.setHashState(mediaId, "FAILED");
      deps.logger.warn({ mediaId }, "hash skipped: source missing");
      return;
    }

    const hash = crypto.createHash("sha256");
    for await (const chunk of res.body) hash.update(chunk as Buffer);
    const contentHash = hash.digest("hex");

    await deps.mediaRepository.setContentHash(mediaId, contentHash);
    await deps.mediaRepository.setHashState(mediaId, "READY");

    const prefs = await deps.preferencesService?.getPreferences(userId).catch(() => null);
    if (prefs?.detectDuplicates) {
      await tagDuplicatesForHash(deps.mediaRepository, userId, mediaId, contentHash);
    }
  };
}
