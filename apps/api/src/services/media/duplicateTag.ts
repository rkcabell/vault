/**
 * Shared "tag byte-identical copies" step, used by both the thumbnail worker
 * (which hashes the buffer it already has in memory) and the hash worker
 * (which stream-hashes everything else), so tagging behavior stays identical
 * no matter which path computed the hash.
 */

export type DuplicateTagRepository = {
  findDuplicateByHash: (userId: string, hash: string, excludeId: string) => Promise<{ id: string } | null>;
  addTagIfAbsent: (mediaId: string, tagName: string) => Promise<void>;
};

/** If another of the user's items shares `contentHash`, tag both "duplicate". */
export async function tagDuplicatesForHash (
  repo: DuplicateTagRepository,
  userId: string,
  mediaId: string,
  contentHash: string,
): Promise<void> {
  const existing = await repo.findDuplicateByHash(userId, contentHash, mediaId);
  if (!existing) return;
  await Promise.all([
    repo.addTagIfAbsent(mediaId, "duplicate"),
    repo.addTagIfAbsent(existing.id, "duplicate"),
  ]);
}
