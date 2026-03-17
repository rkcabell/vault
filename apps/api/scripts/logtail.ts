/**
 * Formats a pino NDJSON log file into a readable transcript.
 * Usage:
 *   npm run log              — format the latest log file
 *   npm run log:watch        — tail the latest log file live
 *   npm run log <file>       — format a specific file
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const LOGS_DIR = path.join(process.cwd(), "logs");
const CURRENT_PTR = path.join(LOGS_DIR, ".current");

// ── ANSI ──────────────────────────────────────────────────────────────────────
const R = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";
const MAGENTA = "\x1b[35m";
const GRAY = "\x1b[90m";

// ── Config ────────────────────────────────────────────────────────────────────
const NAME_COLOR: Record<string, string> = { api: CYAN, worker: MAGENTA };

// Fields already rendered explicitly — skip in extras
const HANDLED = new Set([
  "level", "time", "name", "msg", "message",
  "reqId", "req", "res", "responseTime",
]);

// ── Helpers ───────────────────────────────────────────────────────────────────
function ts (epochMs: number): string {
  return new Date(epochMs).toTimeString().slice(0, 8);
}

function name (n: string | undefined): string {
  if (!n) return "       ";
  const col = NAME_COLOR[n] ?? R;
  return `${col}${n.padEnd(6)}${R}`;
}

function levelPrefix (level: number): string {
  if (level >= 50) return `${RED}ERR${R} `;
  if (level >= 40) return `${YELLOW}WRN${R} `;
  return "    ";
}

function extras (obj: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (HANDLED.has(k) || v === null || v === undefined) continue;
    parts.push(`${GRAY}${k}=${R}${String(v)}`);
  }
  return parts.length ? `  ${parts.join("  ")}` : "";
}

// ── Pre-formatted line colorizer ─────────────────────────────────────────────
// Lines written by fileTransport.mjs look like:
//   2026-03-17 23:50:39  worker   ERR  message    k=v  k=v
// We apply ANSI colors without re-parsing JSON.
const PRE_FMT = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) {2}(\S*)(\s+)(ERR|WRN|TRC|DBG)?(\s*)(.*)/;

function colorizePreFormatted (line: string): string {
  const m = PRE_FMT.exec(line);
  if (!m) return line;
  const [, timestamp, src, gap1, lvl, gap2, rest] = m;
  const srcCol = NAME_COLOR[src?.trim()] ?? R;
  const lvlStr = lvl === "ERR" ? `${RED}ERR${R}` : lvl === "WRN" ? `${YELLOW}WRN${R}` : (lvl ?? "");
  // Colorize key=value pairs in the rest
  const coloredRest = rest.replace(/(\w+)=([^\s]+)/g, `${GRAY}$1=${R}$2`);
  return `${GRAY}${timestamp}${R}  ${srcCol}${src}${R}${gap1}${lvlStr}${gap2}${coloredRest}`;
}

// ── Line formatter ────────────────────────────────────────────────────────────
function format (raw: string): string | null {
  let obj: Record<string, unknown>;
  try { obj = JSON.parse(raw); } catch {
    // File is pre-formatted text from fileTransport.mjs — colorize and echo
    const trimmed = raw.trim();
    return trimmed ? colorizePreFormatted(trimmed) : null;
  }

  const time  = ts((obj.time as number) ?? Date.now());
  const src   = name(obj.name as string | undefined);
  const level = (obj.level as number) ?? 30;
  const msg   = String(obj.msg ?? obj.message ?? "");
  const reqId = obj.reqId ? `${GRAY}[${obj.reqId}]${R}` : "";

  const req = obj.req as { method?: string; url?: string } | undefined;
  const res = obj.res as { statusCode?: number } | undefined;
  const rt  = obj.responseTime as number | undefined;

  let http = "";
  if (req?.method && req?.url) {
    http = `  ${BOLD}${req.method}${R} ${req.url}`;
  }
  if (res?.statusCode !== undefined) {
    const sc = res.statusCode;
    const scCol = sc >= 500 ? RED : sc >= 400 ? YELLOW : GREEN;
    http += `  ${scCol}${sc}${R}`;
    if (rt !== undefined) http += `  ${DIM}${rt.toFixed(1)}ms${R}`;
  }

  return [
    `${GRAY}${time}${R}`,
    src,
    levelPrefix(level) + msg,
    http,
    reqId,
    extras(obj),
  ].filter(Boolean).join(" ").trimEnd();
}

// ── Stream processing ─────────────────────────────────────────────────────────
function pipe (stream: NodeJS.ReadableStream): Promise<void> {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on("line", line => {
      const out = format(line.trim());
      if (out) process.stdout.write(out + "\n");
    });
    rl.on("close", resolve);
  });
}

// ── Entry point ───────────────────────────────────────────────────────────────
const arg  = process.argv[2];
const watch = process.argv.includes("--watch") || process.argv.includes("-w");

let logFile: string;
if (arg && !arg.startsWith("-")) {
  logFile = path.resolve(arg);
} else {
  try { logFile = fs.readFileSync(CURRENT_PTR, "utf8").trim(); }
  catch { console.error("No log file found. Start the server first."); process.exit(1); }
}

if (!fs.existsSync(logFile)) {
  console.error(`Log file not found: ${logFile}`);
  process.exit(1);
}

if (watch) {
  let offset = 0;

  const readNew = async () => {
    const size = fs.statSync(logFile).size;
    if (size <= offset) return;
    const chunk = fs.createReadStream(logFile, { start: offset, end: size - 1, encoding: "utf8" });
    await pipe(chunk);
    offset = size;
  };

  await readNew(); // drain existing content first
  fs.watchFile(logFile, { interval: 250 }, readNew);
} else {
  await pipe(fs.createReadStream(logFile, { encoding: "utf8" }));
}
