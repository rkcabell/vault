// scripts/run-tests.mjs
// Recursively finds *.test.ts files under the given directories — or takes
// individual *.test.ts files — and runs them with node:test. Exists because
// Node 20 does not expand glob patterns in --test, and cmd.exe does not expand
// globs either.
//
// Usage: node scripts/run-tests.mjs <dir|file> [more ...]

import { spawn } from "node:child_process";

import { collectTestsOrExit } from "../../../scripts/lib/findTests.mjs";

const files = collectTestsOrExit(process.argv.slice(2), "scripts/run-tests.mjs");

const child = spawn(process.execPath, ["--import", "tsx/esm", "--test", ...files], {
  stdio: "inherit",
});
child.on("exit", (code) => process.exit(code ?? 0));
