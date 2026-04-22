import { execSync } from "child_process";
import { platform } from "os";

// Patterns match against full command line. Pass args to override defaults.
// Usage: node scripts/stop.mjs [api] [web] [worker]
const ALL = ["api", "web", "worker"];
const requested = process.argv.slice(2);
const targets = requested.length ? requested : ALL;

const PATTERNS = {
  api:    { win: "tsx.*src/index",    unix: "tsx.*src/index\\.ts" },
  web:    { win: "next.*dev",         unix: "next.*dev" },
  worker: { win: "tsx.*src/worker",   unix: "tsx.*src/worker" },
};

const isWindows = platform() === "win32";

for (const target of targets) {
  const pat = PATTERNS[target];
  if (!pat) { console.error(`Unknown target: ${target}`); continue; }

  try {
    if (isWindows) {
      execSync(
        `powershell -NoProfile -Command "` +
          `Get-WmiObject Win32_Process | ` +
          `Where-Object { $_.CommandLine -match '${pat.win}' } | ` +
          `ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`,
        { stdio: "inherit" },
      );
    } else {
      execSync(`pkill -f '${pat.unix}'`, { stdio: "pipe" });
    }
    console.log(`stopped: ${target}`);
  } catch {
    console.log(`not running: ${target}`);
  }
}
