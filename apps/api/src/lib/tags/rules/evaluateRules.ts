/**
 * Applies a user's tagging rules to one item and produces the tags to store
 * on it.
 */
import { MATCHER_SCHEMAS, type TagRuleSource } from "@vault/types";
import { normalizeTag, TagValidationError } from "../normalizeTags.js";
import { buildMimeTypeTag } from "../mimeTypeTag.js";
import { extOf } from "../../media/extensions.js";

/** How a media item entered the library — drives the built-in `source:` axis. */
export type IngestSource = "upload" | "index" | "unpacked";

/**
 * What a rule is allowed to know about one item.
 *
 * A caller supplies only the fields available where it runs. Indexing knows the
 * path on disk and the roots it sits under; the organize worker additionally
 * knows dates read out of the file.
 */
export type MediaFacts = {
  filename: string;
  mimeType?: string | null;
  sizeBytes?: number | null;
  /** Absolute path for in-place indexed items; null/absent for managed storage. */
  sourcePath?: string | null;
  /** Allowed index roots; folder segments are computed relative to the containing root. */
  indexRoots?: string[];
  /** The date the file itself carries. See `resolveFileDate` for which dates count. */
  fileDate?: Date | null;
  ingest?: IngestSource;
};

/** The parts of a stored tagging rule the evaluator reads, without the Prisma row type. */
export type TagRuleInput = {
  source: TagRuleSource;
  matcher: unknown;
  tagTemplate: string;
  priority: number;
  enabled: boolean;
};

// Returns `raw` reduced to the characters a tag value may contain. Kept in
// step with buildMimeTypeTag's own sanitizing.
function sanitizeValue (raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
}

// Returns `p` with forward slashes and no trailing slash, so two paths can be
// compared by prefix.
function normPath (p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

/**
 * Returns the folder names between `sourcePath`'s index root and its filename.
 *
 * Matching a path to its root ignores case, because a Windows root and a walked
 * path may spell the same folder differently.
 */
export function folderSegments (sourcePath: string, indexRoots: string[]): string[] {
  const src = normPath(sourcePath);
  const srcLower = src.toLowerCase();
  for (const root of indexRoots) {
    const r = normPath(root);
    if (!r) continue;
    const rLower = r.toLowerCase();
    if (srcLower === rLower || !srcLower.startsWith(rLower + "/")) continue;
    const rel = src.slice(r.length + 1);
    const parts = rel.split("/");
    parts.pop(); // drop the filename
    return parts.filter(p => p.length > 0);
  }
  return [];
}

// Returns one value per tag the rule produces for this item, or an empty list
// when the rule does not apply. A null entry means the rule matched without
// capturing anything, which only a template with no placeholder can use.
function ruleValues (rule: TagRuleInput, facts: MediaFacts): (string | null)[] {
  const parsed = MATCHER_SCHEMAS[rule.source].safeParse(rule.matcher ?? {});
  if (!parsed.success) return []; // stored matcher no longer valid — skip, never throw
  const matcher = parsed.data;

  switch (rule.source) {
    case "MIME": {
      const { mimePrefixes } = matcher as { mimePrefixes?: string[] };
      const mime = facts.mimeType ?? "";
      if (mimePrefixes?.length && !mimePrefixes.some(p => mime.startsWith(p))) return [];
      return [buildMimeTypeTag(facts.mimeType, facts.filename)];
    }
    case "EXTENSION": {
      const { extensions } = matcher as { extensions?: string[] };
      const ext = extOf(facts.filename);
      if (!ext) return [];
      if (extensions?.length && !extensions.includes(ext)) return [];
      return [ext];
    }
    case "FILENAME": {
      const { pattern } = matcher as { pattern: string };
      let re: RegExp;
      try {
        re = new RegExp(pattern, "i");
      } catch {
        return []; // uncompilable stored pattern — skip
      }
      const m = re.exec(facts.filename);
      if (!m) return [];
      return [m[1] ?? null];
    }
    case "PATH_SEGMENT": {
      if (!facts.sourcePath || !facts.indexRoots?.length) return [];
      const { maxDepth } = matcher as { maxDepth?: number };
      const segments = folderSegments(facts.sourcePath, facts.indexRoots);
      return maxDepth ? segments.slice(0, maxDepth) : segments;
    }
    case "FILE_DATE": {
      const { granularity } = matcher as { granularity: "year" | "month" };
      const d = facts.fileDate;
      if (!d || Number.isNaN(d.getTime())) return [];
      const year = d.getUTCFullYear();
      if (year < 1000 || year > 9999) return []; // corrupt EXIF dates make useless tags
      if (granularity === "year") return [String(year)];
      return [`${year}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`];
    }
    case "SIZE": {
      const { minBytes, maxBytes } = matcher as { minBytes?: number; maxBytes?: number };
      const size = facts.sizeBytes;
      if (size === undefined || size === null) return [];
      if (minBytes !== undefined && size < minBytes) return [];
      if (maxBytes !== undefined && size > maxBytes) return [];
      return [null]; // matched; SIZE rules use a fixed template ("large", not "{value}")
    }
  }
}

/**
 * Returns the tags to apply to one item, from every rule the user has enabled.
 *
 * Results are normalized and deduplicated, and rules run in priority order.
 * The built-in `source:` axis is added whenever the caller supplied an ingest
 * fact, without a rule of its own.
 *
 * A rule that produces an unusable tag is skipped rather than raised, so one
 * bad rule cannot stop an index batch part-way through.
 */
export function evaluateRules (rules: TagRuleInput[], facts: MediaFacts): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  const push = (tag: string) => {
    let normalized: string;
    try {
      normalized = normalizeTag(tag);
    } catch (err) {
      if (err instanceof TagValidationError) return;
      throw err;
    }
    if (!seen.has(normalized)) {
      seen.add(normalized);
      out.push(normalized);
    }
  };

  if (facts.ingest) push(`source:${facts.ingest}`);

  const ordered = [...rules]
    .filter(r => r.enabled)
    .sort((a, b) => a.priority - b.priority);

  for (const rule of ordered) {
    const hasPlaceholder = rule.tagTemplate.includes("{value}");
    for (const value of ruleValues(rule, facts)) {
      if (hasPlaceholder) {
        if (value === null) continue; // matched but produced nothing to substitute
        const sanitized = sanitizeValue(value);
        if (!sanitized) continue;
        push(rule.tagTemplate.replaceAll("{value}", sanitized));
      } else {
        push(rule.tagTemplate);
      }
    }
  }

  return out;
}
