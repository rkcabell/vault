import { z } from "zod";

// ---------------------------------------------------------------------------
// Tags  (GET /tags, POST /tags, DELETE /tags/:tag)
// ---------------------------------------------------------------------------

// USER = the user deliberately applied this tag; AUTO = the system did (MIME-type
// tag on upload/index, bundle/extension tags on unpack). Mirrors the Prisma enum.
export const TagOriginSchema = z.enum(["USER", "AUTO"]);
export type TagOrigin = z.infer<typeof TagOriginSchema>;

export const TagItemSchema = z.object({
  name: z.string(),
  count: z.number(),
  color: z.string().nullable().optional(),
  origin: TagOriginSchema.optional(),
});
export type TagItem = z.infer<typeof TagItemSchema>;

export const TagsListResponseSchema = z.object({
  tags: z.array(TagItemSchema),
});
export type TagsListResponse = z.infer<typeof TagsListResponseSchema>;

export const DeleteTagResponseSchema = z.object({
  ok: z.literal(true),
  tag: z.string(),
});
export type DeleteTagResponse = z.infer<typeof DeleteTagResponseSchema>;

// ---------------------------------------------------------------------------
// Tag normalization (shared between API and web)
// ---------------------------------------------------------------------------

const MAX_TAG_LENGTH = 48;
const MAX_TAGS = 30;
const ALLOWED_CHARS = /^[a-z0-9-]+$/;

export const TAG_RULES = { MAX_TAG_LENGTH, MAX_TAGS };

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
    Object.setPrototypeOf(this, TagValidationError.prototype);
  }
}

export function normalizeTag(tag: unknown): string {
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
    const tag = normalizeTag(raw);
    if (!seen.has(tag)) {
      if (normalized.length >= MAX_TAGS) {
        throw new TagValidationError(
          "TOO_MANY",
          `A maximum of ${MAX_TAGS} tags is allowed`,
        );
      }
      seen.add(tag);
      normalized.push(tag);
    }
  }

  return normalized;
}
