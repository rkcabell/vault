const MAX_TAG_LENGTH = 48;
const MAX_TAGS = 30;
const ALLOWED_CHARS = /^[a-z0-9-]+$/;

export type TagValidationErrorCode =
  | "INVALID_TYPE"
  | "EMPTY"
  | "TOO_LONG"
  | "INVALID_CHARS"
  | "RESERVED_PREFIX"
  | "TOO_MANY";

export class TagValidationError extends Error {
  code: TagValidationErrorCode;
  tag?: string;

  constructor(code: TagValidationErrorCode, message: string, tag?: string) {
    super(message);
    this.name = "TagValidationError";
    this.code = code;
    this.tag = tag;
  }
}

function normalizeTag(tag: unknown): string {
  if (typeof tag !== "string") {
    throw new TagValidationError("INVALID_TYPE", "Tags must be strings", String(tag));
  }

  const trimmed = tag.trim();
  if (trimmed.length === 0) {
    throw new TagValidationError("EMPTY", "Tags cannot be empty", tag);
  }

  if (trimmed.startsWith("_")) {
    throw new TagValidationError("RESERVED_PREFIX", "Tags starting with '_' are reserved", tag);
  }

  let normalized = trimmed.toLowerCase();
  normalized = normalized.replace(/[\s_]+/g, "-");
  normalized = normalized.replace(/-+/g, "-");
  normalized = normalized.replace(/^-+/, "").replace(/-+$/, "");

  if (normalized.length === 0) {
    throw new TagValidationError("EMPTY", "Tags cannot be empty", tag);
  }

  if (normalized.length > MAX_TAG_LENGTH) {
    throw new TagValidationError(
      "TOO_LONG",
      `Tags must be at most ${MAX_TAG_LENGTH} characters`,
      normalized,
    );
  }

  if (!ALLOWED_CHARS.test(normalized)) {
    throw new TagValidationError(
      "INVALID_CHARS",
      "Tags may only contain lowercase letters, digits, and dashes",
      normalized,
    );
  }

  return normalized;
}

export function normalizeTags(input: unknown): string[] {
  if (input === undefined || input === null) return [];

  const rawTags = Array.isArray(input)
    ? input
    : typeof input === "string"
      ? input.split(",")
      : null;

  if (!rawTags) {
    throw new TagValidationError(
      "INVALID_TYPE",
      "Tags must be a string, comma-separated string, or array of strings",
    );
  }

  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const raw of rawTags) {
    if (typeof raw === "string" && raw.trim() === "") continue;
    const tag = normalizeTag(raw);
    if (!seen.has(tag)) {
      seen.add(tag);
      normalized.push(tag);
      if (normalized.length > MAX_TAGS) {
        throw new TagValidationError(
          "TOO_MANY",
          `A maximum of ${MAX_TAGS} tags is allowed`,
          tag,
        );
      }
    }
  }

  return normalized;
}

export const TAG_RULES = { MAX_TAG_LENGTH, MAX_TAGS };

export const TAGS_UPDATED_EVENT = "tags:updated";

export function emitTagsUpdated () {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(TAGS_UPDATED_EVENT));
}
