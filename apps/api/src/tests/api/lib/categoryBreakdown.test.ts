import test from "node:test";
import assert from "node:assert/strict";
import { buildCategoryBreakdown } from "@/lib/media/categoryBreakdown.js";
import type { StorageItem } from "@/lib/media/storageTreemap.js";

function makeItems(specs: Array<{ ext: string; size: number; n: number; mime?: string }>): StorageItem[] {
  const items: StorageItem[] = [];
  let i = 0;
  for (const s of specs) {
    for (let k = 0; k < s.n; k++) {
      items.push({
        id: `id-${i}`,
        title: null,
        filename: `file-${i}.${s.ext}`,
        mimeType: s.mime ?? "application/octet-stream",
        sizeBytes: s.size,
      });
      i++;
    }
  }
  return items;
}

test("buildCategoryBreakdown: empty input", () => {
  assert.deepEqual(buildCategoryBreakdown([]), { categories: [], totalFiles: 0, totalBytes: 0 });
});

test("buildCategoryBreakdown: sums count + bytes per category, filename-aware", () => {
  const items = makeItems([
    { ext: "mp4", size: 1_000_000, n: 3 },  // video
    { ext: "ts",  size: 2_000,     n: 10 }, // code
    { ext: "png", size: 50_000,    n: 4 },  // image
    { ext: "pdf", size: 80_000,    n: 2 },  // pdf
  ]);
  const { categories, totalFiles, totalBytes } = buildCategoryBreakdown(items);

  assert.equal(totalFiles, 19);
  assert.equal(totalBytes, 3_000_000 + 20_000 + 200_000 + 160_000);

  const byBucket = Object.fromEntries(categories.map(c => [c.bucket, c]));
  assert.deepEqual(byBucket.video,  { bucket: "video", count: 3,  bytes: 3_000_000 });
  assert.deepEqual(byBucket.code,   { bucket: "code",  count: 10, bytes: 20_000 });
  assert.deepEqual(byBucket.image,  { bucket: "image", count: 4,  bytes: 200_000 });
  assert.deepEqual(byBucket.pdf,    { bucket: "pdf",   count: 2,  bytes: 160_000 });
});

test("buildCategoryBreakdown: categories sorted by bytes descending", () => {
  const items = makeItems([
    { ext: "ts",  size: 1_000,     n: 5 },  // 5_000 bytes  (code)
    { ext: "mp4", size: 1_000_000, n: 2 },  // 2_000_000    (video)
    { ext: "png", size: 100_000,   n: 3 },  // 300_000      (image)
  ]);
  const { categories } = buildCategoryBreakdown(items);
  assert.deepEqual(categories.map(c => c.bucket), ["video", "image", "code"]);
});

test("buildCategoryBreakdown: falls back to mime prefix, then 'other'", () => {
  const items: StorageItem[] = [
    { id: "1", title: null, filename: "a.weirdext", mimeType: "image/x-weird", sizeBytes: 10 },
    { id: "2", title: null, filename: "b.bin",      mimeType: "application/x-thing", sizeBytes: 20 },
  ];
  const { categories } = buildCategoryBreakdown(items);
  const byBucket = Object.fromEntries(categories.map(c => [c.bucket, c]));
  assert.equal(byBucket.image.count, 1);  // by mime prefix
  assert.equal(byBucket.other.count, 1);  // no signal
});

test("buildCategoryBreakdown: ignores zero/negative-byte files", () => {
  const items = makeItems([
    { ext: "ts",  size: 0,   n: 10 },  // skipped
    { ext: "pdf", size: 100, n: 2 },
  ]);
  const { categories, totalFiles, totalBytes } = buildCategoryBreakdown(items);
  assert.equal(totalFiles, 2);
  assert.equal(totalBytes, 200);
  assert.equal(categories.length, 1);
  assert.equal(categories[0]!.bucket, "pdf");
});
