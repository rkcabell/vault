export function makeStorageKey (userId: string, id: string, filename: string): string {
  return `${userId}/${id}/${filename}`;
}
