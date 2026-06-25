/**
 * Extracts the extension from a filename, lowercased and without the leading dot.
 * extOf("archive.tar.gz") -> "gz"
 * extOf(".env") -> ""
 * extOf("file") -> ""
 */
export function extOf (name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/**
 * Normalize user-provided extensions into a lowercase, dotless, unique array.
 * Used by blacklist
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
