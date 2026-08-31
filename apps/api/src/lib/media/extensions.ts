/**
 * Reads and normalizes file extensions, so a filename and a blacklist entry the
 * user typed compare the same way.
 */

/**
 * Returns a filename's extension, lowercased and without the dot. Only the last
 * one counts, and a name that is all extension has none.
 *
 *     extOf("archive.tar.gz") -> "gz"
 *     extOf(".env")           -> ""
 *     extOf("file")           -> ""
 */
export function extOf (name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/**
 * Normalizes extensions the user typed into a lowercase, dotless, unique list.
 */
export function normalizeExtensions (exts: string[] | undefined): string[] {
  if (!exts) return [];
  const out = new Set<string>();
  for (const raw of exts) {
    const e = raw.trim().toLowerCase().replace(/^\.+/, "");
    if (e) out.add(e);
  }
  return [...out];
}
