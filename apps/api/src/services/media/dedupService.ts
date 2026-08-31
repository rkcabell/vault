import type { FastifyBaseLogger } from "fastify";

/**
 * Groups items that share a SHA-256 content hash, and backfills hashes for items
 * that were never hashed. Matching is byte-identical: two files that look alike
 * to a person but differ by one byte are not duplicates.
 */

/** One item in a group of byte-identical copies. */
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
  resetUnhashedForScan: (userId: string) => Promise<number>;
};

type DedupDeps = {
  repository: DedupRepository;
  logger: FastifyBaseLogger;
};

export function createDedupService (deps: DedupDeps) {
  /** Returns the duplicate groups, and how many READY items still lack a hash. */
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
    // Biggest reclaimable space first: size × the number of extra copies.
    groups.sort(
      (a, b) => b.sizeBytes * (b.items.length - 1) - a.sizeBytes * (a.items.length - 1),
    );
    return { groups, unhashedCount };
  };

  /** Resets every READY item without a content hash so the derivative feeder
   *  claims it. Pushes no hash_queue jobs itself. */
  const startScan = async (userId: string) => {
    const queued = await deps.repository.resetUnhashedForScan(userId);
    deps.logger.info({ userId, queued }, "dedup scan: reset unhashed rows for the feeder");
    return { ok: true, queued };
  };

  return { listDuplicateGroups, startScan };
}
