import type { TagRuleSource } from "@vault/types";

/**
 * The rule set every user starts with. Seeded for new users at registration
 * (tagRuleRepository.seedDefaults) and for existing users by the
 * 20260719000000_tag_rules migration — keep the two in sync.
 *
 * These deliver the deterministic retrieval axes from
 * docs/plans/search-interface.md Stage 1: `type:` (MIME), `year:`/`month:`
 * (EXIF capturedAt → PDF createdAt → mtime), and `folder:` (sourcePath
 * segments under the index roots). The `source:upload|index|unpacked` axis is
 * built into evaluateRules and needs no rule row.
 */
export const DEFAULT_TAG_RULES: ReadonlyArray<{
  name: string;
  source: TagRuleSource;
  matcher: Record<string, unknown>;
  tagTemplate: string;
  priority: number;
}> = [
  { name: "File type", source: "MIME", matcher: {}, tagTemplate: "type:{value}", priority: 0 },
  { name: "Year", source: "FILE_DATE", matcher: { granularity: "year" }, tagTemplate: "year:{value}", priority: 10 },
  { name: "Month", source: "FILE_DATE", matcher: { granularity: "month" }, tagTemplate: "month:{value}", priority: 20 },
  { name: "Folder", source: "PATH_SEGMENT", matcher: {}, tagTemplate: "folder:{value}", priority: 30 },
];
