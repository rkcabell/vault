// Builds the data for the Explore storage treemap.
//
// A vault with tens of thousands of files can't be drawn as one-tile-per-file:
// it's slow (tens of thousands of DOM nodes) and unreadable (every small file
// is a sub-pixel sliver). But showing only the largest files paints a false
// picture — "your vault is all big videos" — when by COUNT it may be mostly
// small code/text files.
//
// So we return two kinds of tiles:
//   1. top-N largest files, exact (weightBytes == sizeBytes).
//   2. a stratified, byte-weighted random SAMPLE of the remaining "tail".
//
// Stratified: the tail is grouped by file-type bucket and sampled in proportion
// to each bucket's file COUNT, so the type mix (code, images, docs…) is honest.
//
// Byte-weighted: each sampled tile's area is scaled so that, per bucket, the
// sample's total area equals the bucket's true byte footprint. The individual
// small tiles look bigger than they are (they're stand-ins), but the treemap as
// a whole stays proportional to real storage — sum(weightBytes) == total bytes.

export type StorageBucket =
  | "pdf" | "image" | "document" | "spreadsheet" | "presentation"
  | "video" | "audio" | "archive" | "code" | "other";

export type StorageItem = {
  id: string;
  title: string | null;
  filename: string;
  mimeType: string;
  sizeBytes: number;
};

export type StorageTile = StorageItem & {
  /** Area weight for the treemap. Equals sizeBytes for top-N; for sampled tiles
   *  it is inflated so the bucket's sample matches the bucket's true bytes. */
  weightBytes: number;
  /** True for tail-sample tiles (drawn with a distinct style + tooltip note). */
  sampled: boolean;
  /** How many tail files this tile represents (1 for top-N, ~k for samples). */
  representsCount: number;
};

export type StorageTreemap = {
  tiles: StorageTile[];
  totalFiles: number;
  totalBytes: number;
};

// Extension → bucket. Mirrors the client's vizUtils TAG_BUCKET so the server's
// stratification lines up with the legend the user sees.
const EXT_BUCKET: Record<string, StorageBucket> = {};
const def = (b: StorageBucket, exts: string[]) => { for (const e of exts) EXT_BUCKET[e] = b; };
def("pdf",          ["pdf"]);
def("document",     ["doc", "docx", "rtf", "odt", "txt", "markdown", "md", "pages", "epub"]);
def("spreadsheet",  ["xls", "xlsx", "csv", "tsv", "ods", "numbers"]);
def("presentation", ["ppt", "pptx", "odp", "key"]);
def("image",        ["jpeg", "jpg", "png", "gif", "webp", "svg", "tiff", "tif", "bmp", "heic", "heif", "avif", "ico", "jxl"]);
def("video",        ["mp4", "webm", "mov", "mkv", "avi", "wmv", "flv", "m4v", "mpeg", "mpg"]);
def("audio",        ["mp3", "wav", "ogg", "flac", "aac", "m4a", "wma", "aiff", "opus"]);
def("archive",      ["zip", "tar", "gz", "tgz", "7z", "rar", "bz2", "xz"]);
def("code",         ["js", "ts", "jsx", "tsx", "json", "html", "css", "scss", "py", "java", "c", "cpp", "h", "go", "rs", "rb", "php", "sh", "xml", "yaml", "yml", "sql", "toml"]);

function mimePrefixBucket(mime: string): StorageBucket | null {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("text/"))  return "document";
  return null;
}

export function bucketOf(mimeType: string, filename: string): StorageBucket {
  const dot = filename.lastIndexOf(".");
  const ext = dot >= 0 ? filename.slice(dot + 1).toLowerCase() : "";
  if (ext && EXT_BUCKET[ext]) return EXT_BUCKET[ext];
  const byMime = mimePrefixBucket((mimeType ?? "").toLowerCase());
  if (byMime) return byMime;
  return "other";
}

/** Pick k distinct items uniformly at random via a partial Fisher-Yates shuffle. */
function sampleK<T>(arr: T[], k: number, rng: () => number): T[] {
  if (k >= arr.length) return arr.slice();
  const copy = arr.slice();
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(rng() * (copy.length - i));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy.slice(0, k);
}

export type BuildTreemapOpts = {
  /** Number of largest files shown exactly. */
  topN?: number;
  /** Total budget for tail-sample tiles, spread across buckets. */
  sampleN?: number;
  /** Injectable RNG for deterministic tests. Defaults to Math.random. */
  rng?: () => number;
};

export function buildStorageTreemap(
  items: StorageItem[],
  opts: BuildTreemapOpts = {},
): StorageTreemap {
  const topN = opts.topN ?? 250;
  const sampleN = opts.sampleN ?? 350;
  const rng = opts.rng ?? Math.random;

  const positive = items.filter(i => i.sizeBytes > 0);
  const totalBytes = positive.reduce((s, i) => s + i.sizeBytes, 0);
  const sorted = positive.slice().sort((a, b) => b.sizeBytes - a.sizeBytes);

  const top = sorted.slice(0, topN);
  const tail = sorted.slice(topN);

  const tiles: StorageTile[] = top.map(i => ({
    ...i,
    weightBytes: i.sizeBytes,
    sampled: false,
    representsCount: 1,
  }));

  if (tail.length > 0 && sampleN > 0) {
    const buckets = new Map<StorageBucket, StorageItem[]>();
    for (const it of tail) {
      const b = bucketOf(it.mimeType, it.filename);
      const arr = buckets.get(b);
      if (arr) arr.push(it);
      else buckets.set(b, [it]);
    }

    for (const arr of buckets.values()) {
      // Sample count ∝ this bucket's share of the tail by file count.
      const share = arr.length / tail.length;
      const s = Math.min(arr.length, Math.max(1, Math.round(sampleN * share)));

      const picked = sampleK(arr, s, rng);
      const bucketBytes = arr.reduce((sum, i) => sum + i.sizeBytes, 0);
      const pickedBytes = picked.reduce((sum, i) => sum + i.sizeBytes, 0);
      // Scale the sample so its total area == the bucket's true bytes. Falls
      // back to an even split if every picked file is zero-byte (shouldn't
      // happen — we filtered sizeBytes>0 — but keeps the math total-safe).
      const scale = pickedBytes > 0 ? bucketBytes / pickedBytes : 0;
      const represents = Math.max(1, Math.round(arr.length / s));

      for (const it of picked) {
        tiles.push({
          ...it,
          weightBytes: pickedBytes > 0 ? it.sizeBytes * scale : bucketBytes / s,
          sampled: true,
          representsCount: represents,
        });
      }
    }
  }

  return { tiles, totalFiles: positive.length, totalBytes };
}
