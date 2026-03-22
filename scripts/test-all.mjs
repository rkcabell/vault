// scripts/test-all.mjs
// Cross-platform test runner: streams api + web tests, then generates HTML report.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

function run(args) {
  const r = spawnSync("npm", args, { stdio: "inherit", shell: true });
  return r.status ?? 1;
}

const apiCode = run(["-w", "api", "run", "test"]);
const webCode = run(["-w", "web", "run", "test"]);

// Generate combined HTML report covering all tests, output to repo root
const htmlScript = fileURLToPath(new URL("../apps/api/scripts/run-tests-html.mjs", import.meta.url));
const apiTests   = fileURLToPath(new URL("../apps/api/src/tests", import.meta.url));
const webTests   = fileURLToPath(new URL("../apps/web/lib", import.meta.url));
spawnSync(process.execPath, [htmlScript, apiTests, webTests], { stdio: "inherit" });

process.exit(apiCode || webCode);
