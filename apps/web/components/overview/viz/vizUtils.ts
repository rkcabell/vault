import { formatMimeTag } from "@/lib/media/utils";

/**
 * File-type colouring for the overview visualisations.
 *
 * Every file is sorted into one of a handful of *buckets* (families of related
 * formats). Each bucket has a single designated base colour, defined once as a
 * CSS variable (`--bucket-<key>`) in globals.css so the palette is themeable in
 * one place. Within a bucket, each individual file type gets a slightly varied
 * shade of the base colour (see `typeColor`), so e.g. PNG and JPEG read as two
 * tones of the same "image" blue. The variation is derived from the type tag,
 * so brand-new/unexpected formats that fall into a bucket still get a sensible
 * colour without needing an explicit entry.
 */

export type BucketKey =
  | "pdf"
  | "image"
  | "document"
  | "spreadsheet"
  | "presentation"
  | "video"
  | "audio"
  | "archive"
  | "code"
  | "other";

/** Short label shown in legends / stat rows. */
export const BUCKET_LABEL: Record<BucketKey, string> = {
  pdf:          "PDF",
  image:        "Images",
  document:     "Docs",
  spreadsheet:  "Sheets",
  presentation: "Slides",
  video:        "Video",
  audio:        "Audio",
  archive:      "Archives",
  code:         "Code",
  other:        "Other",
};

/** Stable display order (also the legend order). */
export const BUCKET_ORDER: BucketKey[] = [
  "pdf", "document", "spreadsheet", "presentation",
  "image", "video", "audio", "archive", "code", "other",
];

/**
 * Fallback base colours (H, S, L) used only during SSR / if the CSS variable
 * can't be read. Keep in sync with the `--bucket-*` definitions in globals.css.
 */
export const FALLBACK_BASE: Record<BucketKey, [number, number, number]> = {
  pdf:          [2,   82, 61],
  image:        [188, 80, 50],
  document:     [234, 76, 60],
  spreadsheet:  [142, 58, 44],
  presentation: [28,  90, 56],
  video:        [268, 68, 64],
  audio:        [322, 70, 60],
  archive:      [45,  86, 52],
  code:         [168, 60, 42],
  other:        [220, 8,  55],
};

/** Explicit tag → bucket membership. Tags are normalised to upper-case. */
const TAG_BUCKET: Record<string, BucketKey> = {};
const define = (b: BucketKey, tags: string[]) => {
  for (const t of tags) TAG_BUCKET[t] = b;
};
define("pdf",          ["PDF"]);
define("document",     ["DOC", "DOCX", "RTF", "ODT", "TXT", "MARKDOWN", "MD", "PAGES", "EPUB"]);
define("spreadsheet",  ["XLS", "XLSX", "CSV", "TSV", "ODS", "NUMBERS"]);
define("presentation", ["PPT", "PPTX", "ODP", "KEY"]);
define("image",        ["JPEG", "JPG", "PNG", "GIF", "WEBP", "SVG", "TIFF", "TIF", "BMP", "HEIC", "HEIF", "AVIF", "ICO", "JXL"]);
define("video",        ["MP4", "WEBM", "MOV", "MKV", "AVI", "WMV", "FLV", "M4V", "MPEG", "MPG"]);
define("audio",        ["MP3", "WAV", "OGG", "FLAC", "AAC", "M4A", "WMA", "AIFF", "OPUS"]);
define("archive",      ["ZIP", "TAR", "GZ", "TGZ", "7Z", "RAR", "BZ2", "XZ"]);
define("code",         ["JS", "TS", "JSX", "TSX", "JSON", "HTML", "CSS", "SCSS", "PY", "JAVA", "C", "CPP", "H", "GO", "RS", "RB", "PHP", "SH", "XML", "YAML", "YML", "SQL", "TOML"]);

/** Catch unexpected formats by their MIME top-level type. */
function mimePrefixBucket(mime: string): BucketKey | null {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("text/"))  return "document";
  return null;
}

export function bucketOf(mimeType: string, filename: string | null): BucketKey {
  const tag = formatMimeTag(mimeType, filename).toUpperCase();
  const byTag = TAG_BUCKET[tag];
  if (byTag) return byTag;
  const byMime = mimePrefixBucket((mimeType ?? "").toLowerCase());
  if (byMime) return byMime;
  return "other";
}

/** Base colour of a bucket, as a CSS string. SSR-safe. */
export function bucketColor(b: BucketKey): string {
  return `hsl(var(--bucket-${b}))`;
}

// ---- per-type shade derivation -------------------------------------------

const baseCache = new Map<BucketKey, { h: number; s: number; l: number }>();

/** Call after programmatically changing `--bucket-*` CSS variables so colors are re-read. */
export function clearBaseCache() { baseCache.clear(); }

function baseHsl(b: BucketKey): { h: number; s: number; l: number } {
  if (typeof window !== "undefined") {
    const cached = baseCache.get(b);
    if (cached) return cached;
    const raw = getComputedStyle(document.documentElement)
      .getPropertyValue(`--bucket-${b}`)
      .trim();
    const m = raw.match(/([\d.]+)\s+([\d.]+)%\s+([\d.]+)%/);
    if (m) {
      const v = { h: +m[1]!, s: +m[2]!, l: +m[3]! };
      baseCache.set(b, v);
      return v;
    }
  }
  const [h, s, l] = FALLBACK_BASE[b];
  return { h, s, l };
}

/** Deterministic 32-bit hash (FNV-1a) of a tag string. */
function hashTag(tag: string): number {
  let h = 2166136261;
  for (let i = 0; i < tag.length; i++) {
    h ^= tag.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

/**
 * Colour for a single file: the bucket's base colour, nudged to a distinct
 * shade within the same family based on the file's type tag. Deterministic, so
 * a given type always renders the same shade.
 */
export function typeColor(mimeType: string, filename: string | null): string {
  const b = bucketOf(mimeType, filename);
  const { h, s, l } = baseHsl(b);
  const n = hashTag(formatMimeTag(mimeType, filename).toUpperCase());

  const dh = (n % 21) - 10;          // hue   ±10
  const ds = ((n >> 8) % 15) - 8;    // sat   -8..+6
  const dl = ((n >> 16) % 27) - 12;  // light -12..+14

  const hue = ((h + dh) % 360 + 360) % 360;
  const sat = clamp(s + ds, 30, 96);
  const lit = clamp(l + dl, 44, 76);
  return `hsl(${hue} ${sat}% ${lit}%)`;
}

// ---- aggregation helpers --------------------------------------------------

/**
 * Buckets present across BOTH the donut's data (the server `typeBreakdown`,
 * which is mime-only) and the treemap's data (the docs list, which also has
 * filenames). Unioning the two keeps a single legend in sync with whatever
 * either chart can render — e.g. a `.zip` whose mime type doesn't map to an
 * archive tag is still surfaced as "Archives" because the treemap buckets it
 * by filename. Colours only; no counts.
 */
export function mergedLegend(
  breakdown: Array<{ mimeType: string; count: number }>,
  docs: Array<{ mimeType: string; filename: string | null }>,
) {
  const present = new Set<BucketKey>();
  for (const { mimeType } of breakdown) present.add(bucketOf(mimeType, null));
  for (const d of docs) present.add(bucketOf(d.mimeType, d.filename));
  return BUCKET_ORDER
    .filter(b => present.has(b))
    .map(b => ({ label: BUCKET_LABEL[b], color: bucketColor(b) }));
}

/** Counts grouped by bucket (used by the donut + stat row). */
export function bucketByLabel(breakdown: Array<{ mimeType: string; count: number }>) {
  const map = new Map<BucketKey, number>();
  for (const { mimeType, count } of breakdown) {
    const b = bucketOf(mimeType, null);
    map.set(b, (map.get(b) ?? 0) + count);
  }
  return BUCKET_ORDER
    .filter(b => map.has(b))
    .map(b => ({ label: BUCKET_LABEL[b], color: bucketColor(b), count: map.get(b)! }));
}
