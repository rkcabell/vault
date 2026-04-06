// scripts/test-all.mjs
// Cross-platform test runner: streams api + web tests, then generates HTML report.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

function run(args) {
  const r = spawnSync("pnpm", args, { stdio: "inherit", shell: true });
  return r.status ?? 1;
}

function readCoverageSummary(path) {
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  const total = parsed?.total;
  if (!total) return null;
  return {
    statements: { pct: total.statements?.pct ?? 0, covered: total.statements?.covered ?? 0, total: total.statements?.total ?? 0 },
    branches: { pct: total.branches?.pct ?? 0, covered: total.branches?.covered ?? 0, total: total.branches?.total ?? 0 },
    functions: { pct: total.functions?.pct ?? 0, covered: total.functions?.covered ?? 0, total: total.functions?.total ?? 0 },
    lines: { pct: total.lines?.pct ?? 0, covered: total.lines?.covered ?? 0, total: total.lines?.total ?? 0 },
  };
}

function fmtPct(value) {
  return `${Number(value).toFixed(2)}%`;
}

function renderCoverageRow(label, c) {
  return `<tr>
    <td>${label}</td>
    <td>${fmtPct(c.statements.pct)}</td>
    <td>${fmtPct(c.branches.pct)}</td>
    <td>${fmtPct(c.functions.pct)}</td>
    <td>${fmtPct(c.lines.pct)}</td>
  </tr>`;
}

function injectCoverageIntoReport(reportPath, coverageRows) {
  if (!existsSync(reportPath) || coverageRows.length === 0) return;
  let html = readFileSync(reportPath, "utf8");

  const styleBlock = `
.coverage-wrap{margin:0 0 1.2rem}
.coverage-title{font-size:.82rem;color:#888;margin-bottom:.45rem}
.coverage-table{width:100%;border-collapse:collapse;background:#0a0a0a;border:1px solid #202020;border-radius:8px;overflow:hidden}
.coverage-table th,.coverage-table td{padding:.45rem .6rem;font-size:.74rem;text-align:left;border-top:1px solid #141414}
.coverage-table thead th{font-size:.7rem;color:#8a8a8a;text-transform:uppercase;letter-spacing:.02em;border-top:none;background:#101010}
.coverage-table tbody td{color:#d0d0d0}
`;
  if (html.includes("</style>") && !html.includes(".coverage-wrap")) {
    html = html.replace("</style>", `${styleBlock}\n</style>`);
  }

  const section = `
<section class="coverage-wrap">
  <p class="coverage-title">Coverage summary (from c8)</p>
  <table class="coverage-table">
    <thead>
      <tr>
        <th>Scope</th>
        <th>Statements</th>
        <th>Branches</th>
        <th>Functions</th>
        <th>Lines</th>
      </tr>
    </thead>
    <tbody>
      ${coverageRows.join("\n      ")}
    </tbody>
  </table>
</section>`;

  if (html.includes('<div class="sort-bar">')) {
    html = html.replace('<div class="sort-bar">', `${section}\n\n<div class="sort-bar">`);
  } else if (!html.includes("Coverage summary (from c8)")) {
    html = html.replace("</body>", `${section}\n</body>`);
  }

  writeFileSync(reportPath, html, "utf8");
}

const apiCode = run(["-F", "api", "run", "coverage"]);
const webCode = run(["-F", "web", "run", "coverage"]);

// Generate combined HTML report covering all tests, output to repo root
const htmlScript = fileURLToPath(new URL("../apps/api/scripts/run-tests-html.mjs", import.meta.url));
const apiTests   = fileURLToPath(new URL("../apps/api/src/tests", import.meta.url));
const webTests   = fileURLToPath(new URL("../apps/web/lib", import.meta.url));
spawnSync(process.execPath, [htmlScript, apiTests, webTests], { stdio: "inherit" });

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const reportPath = join(repoRoot, "test-results", "test-results.html");
const apiCoverage = readCoverageSummary(join(repoRoot, "apps", "api", "coverage", "coverage-summary.json"));
const webCoverage = readCoverageSummary(join(repoRoot, "apps", "web", "coverage", "coverage-summary.json"));
const rows = [
  apiCoverage ? renderCoverageRow("API", apiCoverage) : null,
  webCoverage ? renderCoverageRow("Web (lib only)", webCoverage) : null,
].filter(Boolean);
injectCoverageIntoReport(reportPath, rows);

process.exit(apiCode || webCode);
