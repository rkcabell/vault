/**
 * Works out the date an item is filed under for its year and month tags.
 */
import type { MediaMetadata } from "../../../services/media/metadata/types.js";

/**
 * Returns the date a file itself carries, or null when it carries none.
 *
 * The camera capture date is preferred, then a PDF's creation date, then the
 * file-modified time.
 *
 * The date the item was added to Vault is never used, because a year tag names
 * the file's own year.
 */
export function resolveFileDate (
  meta: MediaMetadata | null | undefined,
  mtimeMs?: number | null,
): Date | null {
  for (const candidate of [meta?.image?.capturedAt, meta?.pdf?.createdAt]) {
    if (typeof candidate === "string" && candidate) {
      const d = new Date(candidate);
      if (!Number.isNaN(d.getTime())) return d;
    }
  }
  if (typeof mtimeMs === "number" && Number.isFinite(mtimeMs) && mtimeMs > 0) {
    return new Date(mtimeMs);
  }
  return null;
}
