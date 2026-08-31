import type { TagRuleSource } from "@vault/types";

/**
 * The tagging rules a new account starts with, giving every item a file type,
 * a year, a month and a folder tag.
 *
 * `tagRuleRepository.seedDefaults` writes these rows for a new user.
 *
 * The `source:` axis, which records how an item entered the library, has no
 * rule here because evaluateRules produces it directly.
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
