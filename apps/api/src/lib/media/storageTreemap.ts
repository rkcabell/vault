/**
 * Builds the tiles for the Explore storage treemap. A library of tens of
 * thousands of files cannot be drawn one tile per file, and drawing only the
 * largest would suggest a library of big videos when most of the files are
 * small. So the result is the largest files exactly, plus a sample of the rest
 * whose areas are scaled to match what those files really occupy.
 */

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

// Extension to bucket. It mirrors the client's TAG_BUCKET, so these categories
// match the legend the user reads.
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
  topN?: number;
  /** Total budget for tail-sample tiles, spread across buckets. */
  sampleN?: number;
  /** Defaults to Math.random. Tests pass one to make the sample repeatable. */
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
      // How many are sampled follows the bucket's share of the tail by count.
      const share = arr.length / tail.length;
      const s = Math.min(arr.length, Math.max(1, Math.round(sampleN * share)));

      const picked = sampleK(arr, s, rng);
      const bucketBytes = arr.reduce((sum, i) => sum + i.sizeBytes, 0);
      const pickedBytes = picked.reduce((sum, i) => sum + i.sizeBytes, 0);
      // Scales the sample so its total area equals the bucket's true bytes.
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
