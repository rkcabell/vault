import { z } from "zod";

// ---------------------------------------------------------------------------
// Tag rules (the Tag Organizer)  (GET/POST/PATCH/DELETE /tag-rules)
//
// A rule reads one deterministic fact about a file (its MIME type, extension,
// filename, source-path segments, file date, or size) and applies a tag built
// from `tagTemplate`, with `{value}` replaced by the rule's computed value.
// No AI/ML — rules are pure functions of file facts (permanent project rule).
// ---------------------------------------------------------------------------

export const TagRuleSourceSchema = z.enum([
  "MIME",
  "EXTENSION",
  "FILENAME",
  "PATH_SEGMENT",
  "FILE_DATE",
  "SIZE",
]);
export type TagRuleSource = z.infer<typeof TagRuleSourceSchema>;

// Per-source matcher configs. Kept strict so a stored matcher always means
// something to the evaluator; unknown keys are rejected at the API boundary.
export const MimeMatcherSchema = z
  .object({
    /** Restrict to MIME types starting with any of these (e.g. ["image/"]). Empty/absent = all. */
    mimePrefixes: z.array(z.string().min(1)).max(20).optional(),
  })
  .strict();

export const ExtensionMatcherSchema = z
  .object({
    /** Match only these extensions (lowercase, no dot). Empty/absent = any extension. */
    extensions: z.array(z.string().regex(/^[a-z0-9]+$/)).max(50).optional(),
  })
  .strict();

export const FilenameMatcherSchema = z
  .object({
    /** Case-insensitive regular expression tested against the filename. The
     *  first capture group (if any) becomes `{value}`. */
    pattern: z.string().min(1).max(200),
  })
  .strict();

export const PathSegmentMatcherSchema = z
  .object({
    /** How many directory levels beneath the index root to tag (1 = only the
     *  top-level folder). Absent = every level. */
    maxDepth: z.number().int().min(1).max(10).optional(),
  })
  .strict();

export const FileDateMatcherSchema = z
  .object({
    granularity: z.enum(["year", "month"]),
  })
  .strict();

export const SizeMatcherSchema = z
  .object({
    minBytes: z.number().nonnegative().optional(),
    maxBytes: z.number().positive().optional(),
  })
  .strict()
  .refine(m => m.minBytes !== undefined || m.maxBytes !== undefined, {
    message: "Provide minBytes and/or maxBytes",
  });

export const MATCHER_SCHEMAS: Record<TagRuleSource, z.ZodTypeAny> = {
  MIME: MimeMatcherSchema,
  EXTENSION: ExtensionMatcherSchema,
  FILENAME: FilenameMatcherSchema,
  PATH_SEGMENT: PathSegmentMatcherSchema,
  FILE_DATE: FileDateMatcherSchema,
  SIZE: SizeMatcherSchema,
};

export const TagRuleSchema = z.object({
  id: z.string(),
  name: z.string(),
  source: TagRuleSourceSchema,
  matcher: z.record(z.unknown()),
  tagTemplate: z.string(),
  priority: z.number().int(),
  enabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TagRuleItem = z.infer<typeof TagRuleSchema>;

export const TagRulesListResponseSchema = z.object({
  rules: z.array(TagRuleSchema),
});
export type TagRulesListResponse = z.infer<typeof TagRulesListResponseSchema>;

// ---------------------------------------------------------------------------
// Retroactive organize run  (POST /tag-rules/run, GET /tag-rules/run/status)
// ---------------------------------------------------------------------------

/** One previewed change in a dry run: the tags that WOULD be added to an item. */
export type OrganizePreviewItem = {
  mediaId: string;
  title: string;
  addTags: string[];
};

export type OrganizeStatus = {
  jobId: string;
  state: string;
  done: boolean;
  dryRun: boolean;
  /** Total media rows considered. */
  total: number;
  processed: number;
  /** Rows that received (or would receive) at least one new tag. */
  updated: number;
  /** Total tag applications added (or previewed). */
  tagsAdded: number;
  /** Per-tag application counts (capped server-side). */
  tagCounts: Record<string, number>;
  /** Dry run only: a small sample of per-item changes. */
  sample?: OrganizePreviewItem[];
};
