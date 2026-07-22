import type { MediaMetadata } from "../../../services/media/metadata/types.js";

/**
 * Best-known "file date" for FILE_DATE rules, in precedence order:
 * EXIF capture date → PDF creation date → filesystem mtime. Returns null when
 * nothing trustworthy exists (e.g. an upload with no embedded date — the ingest
 * timestamp is deliberately NOT used; `year:` means the file's year, not the
 * year it was added to Vault).
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
