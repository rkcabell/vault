// scripts/test-all.mjs
// Cross-platform test runner: streams api + web tests, then generates HTML report.
import { spawnSync } from "node:child_process";

function run(args) {
  const r = spawnSync("npm", args, { stdio: "inherit", shell: true });
  return r.status ?? 1;
}

const apiCode = run(["-w", "api", "run", "test"]);
const webCode = run(["-w", "web", "run", "test"]);
run(["-w", "api", "run", "test:html"]);

process.exit(apiCode || webCode);
