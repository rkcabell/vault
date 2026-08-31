import { bucketOf, type StorageBucket, type StorageItem } from "./storageTreemap.js";

/**
 * Totals the whole library by file-type category, for the overview's storage
 * graph. Categories come from the same `bucketOf` the storage treemap uses, so
 * the user sees one set of buckets in both places.
 */

export type CategorySlice = {
  bucket: StorageBucket;
  count: number;
  bytes: number;
};

export type CategoryBreakdown = {
  categories: CategorySlice[];
  totalFiles: number;
  totalBytes: number;
};

type CategoryInput = Pick<StorageItem, "filename" | "mimeType" | "sizeBytes">;

/** Groups files by type category and sums the count and bytes of each.
 *  Categories come back largest-first by bytes. A file of zero bytes is
 *  skipped. */
export function buildCategoryBreakdown(items: CategoryInput[]): CategoryBreakdown {
  const byBucket = new Map<StorageBucket, CategorySlice>();
  let totalFiles = 0;
  let totalBytes = 0;

  for (const it of items) {
    if (!(it.sizeBytes > 0)) continue;
    const bucket = bucketOf(it.mimeType, it.filename);
    const slice = byBucket.get(bucket);
    if (slice) {
      slice.count += 1;
      slice.bytes += it.sizeBytes;
    } else {
      byBucket.set(bucket, { bucket, count: 1, bytes: it.sizeBytes });
    }
    totalFiles += 1;
    totalBytes += it.sizeBytes;
  }

  const categories = [...byBucket.values()].sort((a, b) => b.bytes - a.bytes);
  return { categories, totalFiles, totalBytes };
}
