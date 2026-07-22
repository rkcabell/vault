import crypto from "node:crypto";
import type { Job, Processor } from "bullmq";
import type { StorageAdapter } from "../adapters/storage/types.js";
import { openSourceStream } from "../adapters/storage/openSource.js";
import { tagDuplicatesForHash, type DuplicateTagRepository } from "../services/media/duplicateTag.js";
import type { HashJobData } from "../queues/enqueueHash.js";

type HashLogger = {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
};

/** Structural deps so the worker is unit-testable with simple fakes. */
type HashWorkerDeps = {
  mediaRepository: DuplicateTagRepository & {
    setContentHash: (mediaId: string, hash: string) => Promise<void>;
  };
  /** detectDuplicates gate; absent = hash only, never tag. */
  preferencesService?: { getPreferences: (userId: string) => Promise<{ detectDuplicates?: boolean }> };
  storage: StorageAdapter;
  bucket: string;
  logger: HashLogger;
};

/**
 * Streams a source's bytes into SHA-256 and persists the digest — the coverage
 * path for items the thumbnail worker never hashes (non-thumbnailable types,
 * too-large files) and for dedup backfill scans. Streaming keeps memory flat
 * regardless of file size. Mirrors the thumb worker's hash step, including the
 * detectDuplicates tagging, via the shared duplicateTag helper.
 */
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
    // Source gone (deleted since enqueue, or the upload never landed): nothing
    // to hash, and retrying won't conjure it back — drop the job quietly.
    if (!res) {
      deps.logger.warn({ mediaId }, "hash skipped: source missing");
      return;
    }

    const hash = crypto.createHash("sha256");
    for await (const chunk of res.body) hash.update(chunk as Buffer);
    const contentHash = hash.digest("hex");

    await deps.mediaRepository.setContentHash(mediaId, contentHash);

    const prefs = await deps.preferencesService?.getPreferences(userId).catch(() => null);
    if (prefs?.detectDuplicates) {
      await tagDuplicatesForHash(deps.mediaRepository, userId, mediaId, contentHash);
    }
  };
}
