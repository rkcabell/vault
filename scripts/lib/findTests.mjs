// scripts/lib/findTests.mjs
// Shared test-file discovery for every runner in the repo:
//   apps/api/scripts/run-tests.mjs
//   apps/api/scripts/run-tests-html.mjs
//   apps/web/scripts/run-tests.mjs
//
// Single source of truth on purpose. This logic previously existed as three
// byte-identical copies, so a fix to one silently left the other two wrong.

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Collect *.test.ts files beneath a directory, recursively.
 *
 * @param {string} dir
 * @returns {string[]} paths, in directory order
 */
function walk (dir) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    const child = join(dir, entry);
    let stats;
    try {
      stats = statSync(child);
    } catch {
      continue; // broken symlink or a file that vanished mid-walk
    }
    if (stats.isDirectory()) results.push(...walk(child));
    else if (child.endsWith(".test.ts")) results.push(child);
  }
  return results;
}

/**
 * Resolve CLI targets — directories (walked recursively) or individual
 * *.test.ts files — into the set of test files to run.
 *
 * Every target that yields nothing is reported in `unresolved` rather than
 * being silently skipped: a mistyped path used to produce a green run that
 * executed no tests, which is worse than a loud failure.
 *
 * @param {string[]} targets
 * @returns {{ files: string[], unresolved: { target: string, reason: string }[] }}
 */
export function collectTests (targets) {
  const files = [];
  const unresolved = [];

  for (const target of targets) {
    let stats;
    try {
      stats = statSync(target);
    } catch {
      unresolved.push({ target, reason: "does not exist" });
      continue;
    }

    if (!stats.isDirectory()) {
      if (target.endsWith(".test.ts")) files.push(target);
      else unresolved.push({ target, reason: "is not a *.test.ts file" });
      continue;
    }

    const found = walk(target);
    if (!found.length) unresolved.push({ target, reason: "contains no *.test.ts files" });
    files.push(...found);
  }

  return { files, unresolved };
}

/**
 * Runner front-end for {@link collectTests}: resolves targets, or prints the
 * problem and exits non-zero. Never returns an empty list — a runner that
 * executes zero tests must not report success.
 *
 * @param {string[]} targets
 * @param {string} scriptName for the usage line
 * @returns {string[]} test file paths (always non-empty)
 */
export function collectTestsOrExit (targets, scriptName) {
  if (!targets.length) {
    console.error(`Usage: node ${scriptName} <dir|file> [more ...]`);
    process.exit(1);
  }

  const { files, unresolved } = collectTests(targets);

  if (unresolved.length) {
    console.error("No test files found for:");
    for (const { target, reason } of unresolved) console.error(`  ${target} — ${reason}`);
    console.error(`(resolved relative to ${process.cwd()})`);
    process.exit(1);
  }

  return files;
}
