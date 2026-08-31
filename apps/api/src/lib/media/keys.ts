/**
 * Builds the storage key for a managed file: the owner's id, the item's id, then
 * the filename. The first segment is what `routes/storage.ts` compares a request
 * against, so a key always has to start with its owner.
 */

export function makeStorageKey (userId: string, id: string, filename: string): string {
  return `${userId}/${id}/${filename}`;
}
