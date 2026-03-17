export function deriveTitle (filename: string, title?: string | null): string {
  if (title && title.trim()) return title.trim();
  const trimmed = filename.trim();
  const base = trimmed.replace(/\.[^/.]+$/, "");
  return base || trimmed || "Untitled";
}
