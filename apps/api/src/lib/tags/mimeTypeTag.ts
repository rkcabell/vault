const MAX_TAG_LENGTH = 48;

function sanitizeMimeType(mimeType: string | undefined | null) {
  if (!mimeType) {
    return "";
  }

  const trimmed = mimeType.trim().toLowerCase();
  const replaced = trimmed.replace(/[^a-z0-9]+/g, "-");
  const squashed = replaced.replace(/-+/g, "-");
  return squashed.replace(/^-+|-+$/g, "");
}

export function buildMimeTypeTag(mimeType: string | undefined | null) {
  const base = sanitizeMimeType(mimeType) || "unknown";
  let safe = base;

  if (safe.length > MAX_TAG_LENGTH) {
    safe = safe.slice(0, MAX_TAG_LENGTH);
    safe = safe.replace(/-+$/, "");
  }

  if (safe.length === 0) {
    safe = "unknown";
  }

  return safe;
}
