/**
 * Works out the title to show for a file: the one the user gave it, or its
 * filename with the extension taken off.
 */

export function deriveTitle (filename: string, title?: string | null): string {
  if (title && title.trim()) return title.trim();
  const trimmed = filename.trim();
  const base = trimmed.replace(/\.[^/.]+$/, "");
  return base || trimmed || "Untitled";
}
