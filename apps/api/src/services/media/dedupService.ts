import type { Queue } from "bullmq";
import type { FastifyBaseLogger } from "fastify";
import { enqueueHashBulk, type HashJobData } from "../../queues/enqueueHash.js";

/** One member of a duplicate group, as returned to the review UI. */
type DuplicateMember = {
  id: string;
  title: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sourcePath: string | null;
  createdAt: Date;
  thumbState: string;
  thumbnailKey: string | null;
  contentHash: string | null;
};

type DedupRepository = {
  listDuplicateMembers: (userId: string) => Promise<DuplicateMember[]>;
  countUnhashed: (userId: string) => Promise<number>;
  listUnhashedPage: (
    userId: string,
    afterId: string | null,
    limit: number,
  ) => Promise<Array<{ id: string; storageKey: string; sourcePath: string | null }>>;
};

type DedupDeps = {
  repository: DedupRepository;
  hashQueue: Queue<HashJobData>;
  /** Current allowed indexing roots — snapshotted into hash jobs for in-place reads. */
  getAllowedRoots: (userId: string) => Promise<string[]>;
  logger: FastifyBaseLogger;
};

const SCAN_CHUNK = 500;

/**
 * Exact-copy deduplication: groups items sharing a SHA-256 contentHash for the
 * review page, and backfills hashes (via hash_queue jobs) for items the
 * thumbnail worker never hashed. Detection is byte-identical only — no
 * perceptual/near-duplicate matching.
 */
export function createDedupService (deps: DedupDeps) {
  /** Byte-identical groups, plus how many READY items still lack a hash. */
  const listDuplicateGroups = async (userId: string) => {
    const [members, unhashedCount] = await Promise.all([
      deps.repository.listDuplicateMembers(userId),
      deps.repository.countUnhashed(userId),
    ]);

    const byHash = new Map<string, DuplicateMember[]>();
    for (const member of members) {
      if (!member.contentHash) continue;
      const group = byHash.get(member.contentHash);
      if (group) group.push(member);
      else byHash.set(member.contentHash, [member]);
    }

    const groups = [...byHash.entries()].map(([contentHash, items]) => ({
      contentHash,
      sizeBytes: items[0]?.sizeBytes ?? 0,
      items: items.map(item => ({
        id: item.id,
        title: item.title,
        filename: item.filename,
        mimeType: item.mimeType,
        sizeBytes: item.sizeBytes,
        sourcePath: item.sourcePath,
        createdAt: item.createdAt,
        thumbState: item.thumbState,
        thumbnailKey: item.thumbnailKey,
      })),
    }));
    // Biggest reclaimable space first (size × extra copies).
    groups.sort(
      (a, b) => b.sizeBytes * (b.items.length - 1) - a.sizeBytes * (a.items.length - 1),
    );
    return { groups, unhashedCount };
  };

  /** Enqueue hash jobs for every READY item without a contentHash. */
  const startScan = async (userId: string) => {
    const allowedRoots = await deps.getAllowedRoots(userId);
    let afterId: string | null = null;
    let queued = 0;
    for (;;) {
      const rows = await deps.repository.listUnhashedPage(userId, afterId, SCAN_CHUNK);
      if (rows.length === 0) break;
      afterId = rows[rows.length - 1].id;
      await enqueueHashBulk(
        deps.hashQueue,
        rows.map(row => ({
          mediaId: row.id,
          userId,
          storageKey: row.storageKey,
          sourcePath: row.sourcePath ?? undefined,
          allowedRoots,
        })),
      );
      queued += rows.length;
    }
    deps.logger.info({ userId, queued }, "dedup scan enqueued");
    return { ok: true, queued };
  };

  return { listDuplicateGroups, startScan };
}
