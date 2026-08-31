/**
 * Summarizes a V8 `.cpuprofile` as two tables of self time, one by function and
 * one by source file.
 *
 *   node scripts/bench/analyzeCpuProfile.mjs ./bench-results/thumb-cpuprof-c4.cpuprofile
 */
import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) { console.error("usage: analyzeCpuProfile.mjs <path.cpuprofile>"); process.exit(1); }

const profile = JSON.parse(readFileSync(file, "utf8"));
const nodes = new Map(profile.nodes.map(n => [n.id, n]));

const totalMicros = profile.endTime - profile.startTime;
const totalHits = profile.nodes.reduce((s, n) => s + (n.hitCount ?? 0), 0);

// Returns the final path segment of a profile frame's script URL. A frame with
// no URL is native code.
function basename (url) {
  if (!url) return "(native/unknown)";
  const clean = url.split("?")[0];
  const parts = clean.split(/[\\/]/);
  return parts[parts.length - 1] || clean;
}

const byFunction = new Map();
const byFile = new Map();

for (const n of profile.nodes) {
  const hits = n.hitCount ?? 0;
  if (hits === 0) continue;
  const fn = n.callFrame.functionName || "(anonymous)";
  const file = basename(n.callFrame.url);
  const key = `${fn}  [${file}:${n.callFrame.lineNumber + 1}]`;
  byFunction.set(key, (byFunction.get(key) ?? 0) + hits);
  byFile.set(file, (byFile.get(file) ?? 0) + hits);
}

const pct = hits => ((hits / totalHits) * 100).toFixed(1);

console.log(`profile: ${file}`);
console.log(`duration: ${(totalMicros / 1e6).toFixed(1)}s, total samples (hits): ${totalHits}, node count: ${nodes.size}\n`);

console.log("=== self time by source file ===");
for (const [f, hits] of [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
  console.log(`  ${pct(hits).padStart(5)}%  ${String(hits).padStart(7)}  ${f}`);
}

console.log("\n=== self time by function (top 30) ===");
for (const [k, hits] of [...byFunction.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)) {
  console.log(`  ${pct(hits).padStart(5)}%  ${String(hits).padStart(7)}  ${k}`);
}
