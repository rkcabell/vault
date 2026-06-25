import test from "node:test";
import assert from "node:assert/strict";
import { buildStorageTreemap, bucketOf, type StorageItem } from "@/lib/media/storageTreemap.js";

// Deterministic RNG so sampling is reproducible in tests.
function mulberry32(seed: number) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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

test("bucketOf: classifies by extension, then mime prefix, then other", () => {
  assert.equal(bucketOf("application/octet-stream", "a.ts"), "code");
  assert.equal(bucketOf("application/pdf", "a.pdf"), "pdf");
  assert.equal(bucketOf("image/png", "a.png"), "image");
  // unknown ext falls back to mime prefix
  assert.equal(bucketOf("image/x-weird", "a.weirdext"), "image");
  // no signal at all
  assert.equal(bucketOf("application/x-thing", "a.bin"), "other");
});

test("buildStorageTreemap: weightBytes sum equals total bytes (byte-accurate)", () => {
  const items = makeItems([
    { ext: "mp4", size: 1_000_000, n: 5 },   // big videos
    { ext: "ts",  size: 2_000,     n: 800 },  // many small code files
    { ext: "png", size: 50_000,    n: 120 },  // medium images
  ]);
  const total = items.reduce((s, i) => s + i.sizeBytes, 0);

  const { tiles, totalBytes, totalFiles } = buildStorageTreemap(items, {
    topN: 50, sampleN: 200, rng: mulberry32(1),
  });

  assert.equal(totalFiles, items.length);
  assert.equal(totalBytes, total);
  const weightSum = tiles.reduce((s, t) => s + t.weightBytes, 0);
  // float tolerance
  assert.ok(Math.abs(weightSum - total) < 1e-6 * total, `weightSum ${weightSum} vs ${total}`);
});

test("buildStorageTreemap: top-N are the largest, exact, and not sampled", () => {
  const items = makeItems([
    { ext: "mp4", size: 9_000_000, n: 3 },
    { ext: "ts",  size: 1_000,     n: 500 },
  ]);
  const { tiles } = buildStorageTreemap(items, { topN: 3, sampleN: 100, rng: mulberry32(2) });

  const top = tiles.filter(t => !t.sampled);
  assert.equal(top.length, 3);
  for (const t of top) {
    assert.equal(t.weightBytes, t.sizeBytes); // exact
    assert.equal(t.representsCount, 1);
    assert.equal(t.sizeBytes, 9_000_000);      // the three biggest
  }
});

test("buildStorageTreemap: total tile count stays bounded", () => {
  const items = makeItems([
    { ext: "ts",  size: 1_000, n: 5_000 },
    { ext: "png", size: 9_000, n: 5_000 },
    { ext: "pdf", size: 4_000, n: 5_000 },
  ]);
  const topN = 250, sampleN = 350;
  const { tiles } = buildStorageTreemap(items, { topN, sampleN, rng: mulberry32(3) });
  // top-N + sample (sample may slightly exceed sampleN due to per-bucket min/rounding,
  // but is bounded by topN + sampleN + bucketCount).
  assert.ok(tiles.length <= topN + sampleN + 10, `got ${tiles.length}`);
  assert.ok(tiles.length >= topN, `got ${tiles.length}`);
});

test("buildStorageTreemap: stratified sample includes each tail type present", () => {
  const items = makeItems([
    { ext: "mp4", size: 8_000_000, n: 2 },   // top-N
    { ext: "ts",  size: 1_000,     n: 600 },  // code tail
    { ext: "png", size: 30_000,    n: 200 },  // image tail
    { ext: "pdf", size: 80_000,    n: 40 },   // pdf tail
  ]);
  const { tiles } = buildStorageTreemap(items, { topN: 2, sampleN: 150, rng: mulberry32(4) });
  const sampledBuckets = new Set(
    tiles.filter(t => t.sampled).map(t => bucketOf(t.mimeType, t.filename)),
  );
  assert.ok(sampledBuckets.has("code"));
  assert.ok(sampledBuckets.has("image"));
  assert.ok(sampledBuckets.has("pdf"));
});

test("buildStorageTreemap: sampled tiles carry representsCount > 1 for big buckets", () => {
  const items = makeItems([
    { ext: "ts", size: 1_000, n: 1_000 },
  ]);
  const { tiles } = buildStorageTreemap(items, { topN: 10, sampleN: 50, rng: mulberry32(5) });
  const sampled = tiles.filter(t => t.sampled);
  assert.ok(sampled.length > 0);
  // ~990 tail files / ~50 samples => each represents ~20
  assert.ok(sampled.every(t => t.representsCount > 1));
});

test("buildStorageTreemap: ignores zero/negative sizes and handles empty input", () => {
  assert.deepEqual(buildStorageTreemap([], {}), { tiles: [], totalFiles: 0, totalBytes: 0 });

  const items = makeItems([{ ext: "ts", size: 0, n: 10 }, { ext: "pdf", size: 100, n: 1 }]);
  const { tiles, totalFiles, totalBytes } = buildStorageTreemap(items, { rng: mulberry32(6) });
  assert.equal(totalFiles, 1);
  assert.equal(totalBytes, 100);
  assert.equal(tiles.length, 1);
});

test("buildStorageTreemap: no tail means no sampled tiles", () => {
  const items = makeItems([{ ext: "pdf", size: 100, n: 5 }]);
  const { tiles } = buildStorageTreemap(items, { topN: 250, sampleN: 350, rng: mulberry32(7) });
  assert.equal(tiles.length, 5);
  assert.ok(tiles.every(t => !t.sampled));
});
