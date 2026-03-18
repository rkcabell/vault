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

const HEIC_EXTENSIONS = new Set(["heic", "heif"]);

const EXT_MIME_OVERRIDES: Record<string, string> = {
  heic: "image/heic",
  heif: "image/heif",
};

/**
 * Corrects a browser-reported MIME type using the file extension when the
 * browser supplies a generic type (e.g. application/octet-stream for HEIC).
 */
export function normalizeMimeType(mimeType: string | undefined | null, filename?: string): string {
  const lower = mimeType?.trim().toLowerCase() ?? "";
  if (!lower || lower === "application/octet-stream") {
    const ext = filename?.split(".").pop()?.toLowerCase() ?? "";
    if (EXT_MIME_OVERRIDES[ext]) return EXT_MIME_OVERRIDES[ext];
  }
  return mimeType?.trim() ?? "application/octet-stream";
}

export function buildMimeTypeTag(mimeType: string | undefined | null, filename?: string) {
  // HEIC files from iOS/browsers often arrive as application/octet-stream
  const ext = filename?.split(".").pop()?.toLowerCase();
  if (HEIC_EXTENSIONS.has(ext ?? "") && (!mimeType || mimeType.toLowerCase() === "application/octet-stream")) {
    return "image-heic";
  }

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
