// Aggregates the whole vault into per-file-type-category totals (file count +
// total bytes) for the overview "storage by type" graph.
//
// Reuses the same filename-aware `bucketOf` as the per-file storage treemap, so
// the categories here line up exactly with the buckets/legend the user sees
// elsewhere. Zero/negative-byte files are ignored — they contribute no area.

import { bucketOf, type StorageBucket, type StorageItem } from "./storageTreemap.js";

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

/** Group files into type categories + sum count & bytes per category.
 *  Categories are returned largest-first by total bytes. */
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
