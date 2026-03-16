// scripts/run-tests.mjs
// Recursively finds *.test.ts files under the given directories and runs them
// with node:test. Exists because Node 20 does not expand glob patterns in
// --test, and cmd.exe does not expand globs either.
//
// Usage: node scripts/run-tests.mjs <dir> [dir2 ...]

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

function findTests(dir) {
  const results = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return results; // directory doesn't exist yet — that's fine
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...findTests(full));
    } else if (entry.endsWith(".test.ts")) {
      results.push(full);
    }
  }
  return results;
}

const dirs = process.argv.slice(2);
const files = dirs.flatMap(findTests);

if (!files.length) {
  console.log("No test files found.");
  process.exit(0);
}

const child = spawn(process.execPath, ["--import", "tsx/esm", "--test", ...files], {
  stdio: "inherit",
});
child.on("exit", (code) => process.exit(code ?? 0));
