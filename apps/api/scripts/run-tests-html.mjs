// scripts/run-tests-html.mjs
// Runs each test file individually with TAP reporter, collects results,
// and generates a self-contained HTML report grouped by file (suite).
//
// Usage: node scripts/run-tests-html.mjs <dir> [dir2 ...]
// Output: test-results.html in the cwd

import { readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { spawn } from "node:child_process";

// ── File discovery ────────────────────────────────────────────────────────────

function findTests(dir) {
  const results = [];
  let entries;
  try { entries = readdirSync(dir); } catch { return results; }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) results.push(...findTests(full));
    else if (entry.endsWith(".test.ts")) results.push(full);
  }
  return results;
}

// ── Run a single file with TAP reporter ──────────────────────────────────────

function runFile(file) {
  return new Promise((resolve_) => {
    const start = Date.now();
    let tap = "";
    const child = spawn(
      process.execPath,
      ["--import", "tsx/esm", "--test", "--test-reporter=tap", file],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    child.stdout.on("data", c => { tap += c.toString(); });
    child.stderr.on("data", () => {});
    child.on("exit", code => {
      resolve_({ tap, exitCode: code ?? 0, duration: Date.now() - start });
    });
  });
}

// ── Bounded concurrency pool ──────────────────────────────────────────────────

async function runPool(items, fn, concurrency = 8) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

// ── Single-file TAP parser ────────────────────────────────────────────────────
// Single-file TAP has no file-level wrapper. Every col-0 ok/not ok line is a test.

function parseSingleFileTap(tap) {
  const tests = [];
  let diagBuf = [];
  let inDiag = false;
  let lastTest = null;

  for (const line of tap.split(/\r?\n/)) {
    const trimmed = line.trimStart();

    if (trimmed === "---") { inDiag = !inDiag; continue; }
    if (inDiag) { diagBuf.push(trimmed); continue; }

    // Only top-level (col 0) result lines
    if (trimmed === line) {
      const m = trimmed.match(/^(ok|not ok) \d+ - (.+)$/);
      if (m) {
        if (diagBuf.length && lastTest) lastTest.diag = [...diagBuf];
        diagBuf = [];
        const pass = m[1] === "ok";
        const rawName = m[2].replace(/\s*#\s*time=[\d.]+ms\s*$/, "").trim();
        const skip = /# SKIP/i.test(rawName);
        const name = rawName.replace(/\s*#\s*(SKIP|TODO).*$/i, "").trim();
        lastTest = { name, pass, skip, diag: [] };
        tests.push(lastTest);
      }
    }
  }
  if (diagBuf.length && lastTest) lastTest.diag = [...diagBuf];
  return tests;
}

// ── HTML helpers ──────────────────────────────────────────────────────────────

function esc(str) {
  return String(str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function buildHtml(suites, totalElapsed) {
  const totalTests  = suites.reduce((n, s) => n + s.tests.length, 0);
  const totalPassed = suites.reduce((n, s) => n + s.tests.filter(t => t.pass && !t.skip).length, 0);
  const totalFailed = suites.reduce((n, s) => n + s.tests.filter(t => !t.pass && !t.skip).length, 0);
  const totalSkipped= suites.reduce((n, s) => n + s.tests.filter(t => t.skip).length, 0);
  const statusClass = totalFailed > 0 ? "fail" : "pass";

  const suiteHtml = suites.map((s, i) => {
    const failed = s.tests.filter(t => !t.pass && !t.skip).length;
    const passed = s.tests.filter(t => t.pass && !t.skip).length;
    const ok = failed === 0;
    const icon = ok ? "✓" : "✗";
    const cls  = ok ? "suite-pass" : "suite-fail";

    const testRows = s.tests.map(t => {
      const tIcon = t.skip ? "–" : t.pass ? "✓" : "✗";
      const tCls  = t.skip ? "test-skip" : t.pass ? "test-pass" : "test-fail";
      const diagHtml = !t.pass && t.diag?.length
        ? `<tr class="diag-row"><td colspan="2"><pre class="diag">${esc(t.diag.join("\n"))}</pre></td></tr>`
        : "";
      return `<tr class="${tCls}"><td class="icon">${tIcon}</td><td class="test-name">${esc(t.name)}</td></tr>${diagHtml}`;
    }).join("");

    return `<details class="suite ${cls}" ${ok ? "" : "open"}
      data-status="${ok ? 1 : 0}"
      data-name="${esc(s.label.toLowerCase())}"
      data-duration="${s.duration}"
      data-index="${i}">
  <summary>
    <span class="suite-icon">${icon}</span>
    <span class="suite-label">${esc(s.label)}</span>
    <span class="suite-counts">
      ${failed > 0 ? `<span class="ct-fail">${failed} failed</span>` : ""}
      <span class="ct-pass">${passed} passed</span>
      ${s.tests.filter(t=>t.skip).length > 0 ? `<span class="ct-skip">${s.tests.filter(t=>t.skip).length} skipped</span>` : ""}
      <span class="ct-time">${s.duration} ms</span>
    </span>
  </summary>
  <table class="test-table"><tbody>${testRows}</tbody></table>
</details>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Test Results — Vault API</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,sans-serif;background:#0d0d0d;color:#e0e0e0;padding:2rem;max-width:900px;margin:0 auto}
h1{font-size:1.4rem;font-weight:600;color:#fff;margin-bottom:.2rem}
.meta{font-size:.78rem;color:#555;margin-bottom:1.4rem}
.status-bar{display:inline-flex;align-items:center;gap:.5rem;padding:.35rem .9rem;border-radius:6px;font-size:.8rem;font-weight:700;margin-bottom:1.2rem}
.status-bar.pass{background:#1a3a1a;color:#4caf50}
.status-bar.fail{background:#3a1a1a;color:#ef5350}
.summary{display:flex;gap:.6rem;margin-bottom:1.4rem;flex-wrap:wrap}
.chip{padding:.3rem .8rem;border-radius:999px;font-size:.75rem;font-weight:600}
.chip.pass {background:#1a3a1a;color:#4caf50;border:1px solid #2e7d32}
.chip.fail {background:#3a1a1a;color:#ef5350;border:1px solid #b71c1c}
.chip.skip {background:#2a2a1a;color:#ffc107;border:1px solid #f57f17}
.chip.total{background:#1a1a2a;color:#90caf9;border:1px solid #1565c0}
.chip.time {background:#1a1a1a;color:#666;   border:1px solid #2a2a2a}
.sort-bar{display:flex;align-items:center;gap:.4rem;margin-bottom:.8rem;flex-wrap:wrap}
.sort-bar span{font-size:.72rem;color:#555}
.sort-btn{background:#141414;border:1px solid #2a2a2a;color:#666;font-size:.72rem;padding:.25rem .6rem;border-radius:4px;cursor:pointer;transition:all .1s}
.sort-btn:hover{border-color:#444;color:#bbb}
.sort-btn.active{border-color:#4a6fa5;color:#90caf9;background:#0d1f35}
.suites{display:flex;flex-direction:column;gap:.4rem}
details.suite{border-radius:7px;overflow:hidden;border:1px solid #1e1e1e}
.suite-pass{border-color:#1e1e1e}
.suite-fail{border-color:#361b1b}
summary{display:flex;align-items:center;gap:.6rem;padding:.6rem 1rem;cursor:pointer;list-style:none;user-select:none}
summary::-webkit-details-marker{display:none}
.suite-pass summary{background:#141414}
.suite-fail summary{background:#1a0d0d}
summary:hover{filter:brightness(1.3)}
.suite-icon{font-size:.85rem;width:1rem;text-align:center;flex-shrink:0}
.suite-pass .suite-icon{color:#4caf50}
.suite-fail .suite-icon{color:#ef5350}
.suite-label{flex:1;font-size:.82rem;font-weight:500;color:#ccc;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.suite-counts{display:flex;gap:.5rem;align-items:center;flex-shrink:0}
.ct-fail{font-size:.7rem;color:#ef5350;font-weight:600}
.ct-pass{font-size:.7rem;color:#388e3c}
.ct-skip{font-size:.7rem;color:#fbc02d}
.ct-time{font-size:.7rem;color:#444}
.test-table{width:100%;border-collapse:collapse;background:#0a0a0a}
.test-table tr{border-top:1px solid #141414}
.test-table td{padding:.35rem 1rem;font-size:.78rem;vertical-align:top}
.icon{width:1.4rem;text-align:center}
.test-pass .icon{color:#4caf50}
.test-fail .icon{color:#ef5350}
.test-skip .icon{color:#fbc02d}
.test-name{color:#bbb}
.test-fail .test-name{color:#ffcdd2}
.test-skip .test-name{color:#888}
.diag-row td{padding:0}
pre.diag{font-size:.7rem;background:#150505;color:#ff8a80;padding:.5rem 1rem;overflow-x:auto;margin:0;border-top:1px solid #2a0a0a}
</style>
</head>
<body>
<h1>Vault API — Test Results</h1>
<p class="meta">Generated ${new Date().toLocaleString()} &nbsp;·&nbsp; ${suites.length} suites</p>

<div class="status-bar ${statusClass}">${statusClass === "pass" ? "✓ All tests passed" : "✗ Tests failed"}</div>

<div class="summary">
  <span class="chip total">${totalTests} tests</span>
  <span class="chip pass">✓ ${totalPassed} passed</span>
  ${totalFailed  > 0 ? `<span class="chip fail">✗ ${totalFailed} failed</span>` : ""}
  ${totalSkipped > 0 ? `<span class="chip skip">– ${totalSkipped} skipped</span>` : ""}
  <span class="chip time">⏱ ${(totalElapsed / 1000).toFixed(2)} s</span>
</div>

<div class="sort-bar">
  <span>Sort:</span>
  <button class="sort-btn active" data-sort="status">Status</button>
  <button class="sort-btn" data-sort="name-asc">Name A→Z</button>
  <button class="sort-btn" data-sort="name-desc">Name Z→A</button>
  <button class="sort-btn" data-sort="duration-desc">Slowest first</button>
  <button class="sort-btn" data-sort="duration-asc">Fastest first</button>
</div>

<div class="suites" id="suites">
${suiteHtml}
</div>

<script>
const container = document.getElementById('suites');
const buttons = document.querySelectorAll('.sort-btn');
function sort(key) {
  const items = [...container.querySelectorAll('details.suite')];
  items.sort((a, b) => {
    if (key === 'status') {
      const d = Number(a.dataset.status) - Number(b.dataset.status);
      return d !== 0 ? d : a.dataset.name.localeCompare(b.dataset.name);
    }
    if (key === 'name-asc')      return a.dataset.name.localeCompare(b.dataset.name);
    if (key === 'name-desc')     return b.dataset.name.localeCompare(a.dataset.name);
    if (key === 'duration-desc') return Number(b.dataset.duration) - Number(a.dataset.duration);
    if (key === 'duration-asc')  return Number(a.dataset.duration) - Number(b.dataset.duration);
    return Number(a.dataset.index) - Number(b.dataset.index);
  });
  items.forEach(el => container.appendChild(el));
}
buttons.forEach(btn => btn.addEventListener('click', () => {
  buttons.forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  sort(btn.dataset.sort);
}));
sort('status');
</script>
</body>
</html>`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

const dirs = process.argv.slice(2);
const files = dirs.flatMap(findTests);

if (!files.length) { console.log("No test files found."); process.exit(0); }

const root = resolve(".");
console.log(`Generating report… (${files.length} files)`);
const start = Date.now();

const runResults = await runPool(files, runFile, 8);

let anyFail = false;
const suites = runResults.map((r, i) => {
  if (r.exitCode !== 0) anyFail = true;
  return {
    label: relative(root, resolve(files[i])).replace(/\\/g, "/"),
    tests: parseSingleFileTap(r.tap),
    duration: r.duration,
  };
});

const totalElapsed = Date.now() - start;
const html = buildHtml(suites, totalElapsed);
const outputPath = resolve("test-results.html");
writeFileSync(outputPath, html, "utf8");
console.log(`Report → file:///${outputPath.replace(/\\/g, "/")}`);
process.exit(anyFail ? 1 : 0);
