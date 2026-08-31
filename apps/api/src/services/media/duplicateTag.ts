/**
 * Tags byte-identical copies of a file as duplicates. Called by the thumbnail
 * worker, which hashes the buffer it already holds, and by the hash worker,
 * which hashes everything else from a stream.
 */

export type DuplicateTagRepository = {
  findDuplicateByHash: (userId: string, hash: string, excludeId: string) => Promise<{ id: string } | null>;
  addTagIfAbsent: (mediaId: string, tagName: string) => Promise<void>;
};

/** Tags both items "duplicate" when another of the user's items shares `contentHash`. */
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
