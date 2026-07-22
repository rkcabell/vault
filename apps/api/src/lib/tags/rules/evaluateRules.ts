import { MATCHER_SCHEMAS, type TagRuleSource } from "@vault/types";
import { normalizeTag, TagValidationError } from "../normalizeTags.js";
import { buildMimeTypeTag } from "../mimeTypeTag.js";
import { extOf } from "../../media/extensions.js";

/** How a media item entered the library — drives the built-in `source:` axis. */
export type IngestSource = "upload" | "index" | "unpacked";

/**
 * The deterministic facts a rule can read about one media item. Call sites pass
 * whatever they know at that moment: upload knows filename/MIME/size, indexing
 * additionally knows sourcePath (+ roots) and mtime, the retroactive organize
 * worker knows everything including extracted EXIF/PDF dates.
 */
export type MediaFacts = {
  filename: string;
  mimeType?: string | null;
  sizeBytes?: number | null;
  /** Absolute path for in-place indexed items; null/absent for managed storage. */
  sourcePath?: string | null;
  /** Allowed index roots; folder segments are computed relative to the containing root. */
  indexRoots?: string[];
  /** Best-known file date (EXIF capturedAt → PDF createdAt → fs mtime). */
  fileDate?: Date | null;
  ingest?: IngestSource;
};

/** The subset of a TagRule row the evaluator needs (Prisma-independent). */
export type TagRuleInput = {
  source: TagRuleSource;
  matcher: unknown;
  tagTemplate: string;
  priority: number;
  enabled: boolean;
};

/** Strip characters a tag value may not contain (mirrors buildMimeTypeTag's
 *  sanitization): lowercase, whitespace/underscores → dash, drop the rest. */
function sanitizeValue (raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
}

/** Path with forward slashes and no trailing slash, for prefix comparison. */
function normPath (p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

/**
 * Directory segments of `sourcePath` beneath its containing index root,
 * excluding the filename. Comparison is case-insensitive (NTFS roots and walked
 * paths can differ in case; roots come from the same canonical source, so a
 * false cross-case match is not a real concern).
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

/** Values a rule computed; each becomes one tag via the template. `null` in the
 *  list means "matched, but no capture" (usable only by placeholder-free templates). */
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
 * Evaluate every enabled rule against one media item's facts, returning the
 * normalized, deduplicated tags to apply. Pure: no I/O, no clock, no Prisma —
 * unit-testable and safe to call from any ingest site or worker.
 *
 * Always includes the built-in `source:upload|index|unpacked` axis when the
 * ingest fact is present (it needs no configuration and every retrieval flow
 * benefits from it). Rules that error (bad template, invalid value chars,
 * over-length tag) are skipped silently — one broken rule must never block an
 * upload or an index batch.
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
