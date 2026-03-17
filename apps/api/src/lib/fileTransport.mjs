/**
 * Pino worker-thread transport — writes human-readable plain-text log lines to a file.
 * Must be plain ESM (.mjs) — pino transports run in a worker_threads Worker that has
 * no tsx / TypeScript loader, so .ts files cannot be used here.
 *
 * Accepts opts.currentPtr: path to the .current pointer file.
 * Polls every 2 seconds so when the API server restarts and creates a new log file,
 * the worker automatically switches to it without restarting.
 *
 * Output format (Linux syslog style):
 *   2026-03-17 23:50:39  worker   thumb job completed    jobName=thumb  durationMs=97
 *   2026-03-17 23:50:39  api      ERR  server error    method=GET  url=/api/media  status=500
 */
import { createWriteStream, readFileSync } from "node:fs";
import abstractTransport from "pino-abstract-transport";

// Fields rendered explicitly — omit from key=value extras
const HANDLED = new Set([
  "level", "time", "name",
  "msg", "message",
  "pid", "hostname",
  "reqId", "req", "res", "responseTime",
]);

// Only show a label for non-info levels
const LEVEL_LABELS = {
  10: "TRC",
  20: "DBG",
  30: "   ",   // INFO — 3-space placeholder keeps MESSAGE column aligned
  40: "WRN",
  50: "ERR",
  60: "FTL",
};

function formatLine(obj) {
  // ── Timestamp ────────────────────────────────────────────────────────────
  const d = new Date(obj.time ?? Date.now());
  const date = d.toISOString().slice(0, 10);           // "2026-03-17"
  const time = d.toTimeString().slice(0, 8);           // "23:50:39"
  const ts = `${date} ${time}`;

  // ── Source name (padded for alignment) ──────────────────────────────────
  const src = (obj.name ?? "").padEnd(7);

  // ── Level label ──────────────────────────────────────────────────────────
  const lvl = LEVEL_LABELS[obj.level ?? 30] ?? "";

  // ── Message ──────────────────────────────────────────────────────────────
  const msg = String(obj.msg ?? obj.message ?? "");

  // ── HTTP info (from Fastify req/res serializers) ─────────────────────────
  let http = "";
  if (obj.req?.method && obj.req?.url) {
    http = `${obj.req.method} ${obj.req.url}`;
  }
  if (obj.res?.statusCode !== undefined) {
    http += (http ? "  " : "") + String(obj.res.statusCode);
    if (obj.responseTime !== undefined) {
      http += `  ${Number(obj.responseTime).toFixed(1)}ms`;
    }
  }

  // ── Request ID ───────────────────────────────────────────────────────────
  const reqId = obj.reqId ? `[${obj.reqId}]` : "";

  // ── Remaining fields as key=value ────────────────────────────────────────
  const parts = [];
  for (const [k, v] of Object.entries(obj)) {
    if (HANDLED.has(k) || v == null) continue;
    const str = typeof v === "object" ? JSON.stringify(v) : String(v);
    parts.push(`${k}=${str}`);
  }
  const extras = parts.join("  ");

  // ── Assemble ──────────────────────────────────────────────────────────────
  const segments = [ts, src, lvl, msg, http, reqId, extras];
  return segments.filter(Boolean).join("  ").trimEnd() + "\n";
}

export default async function build(opts) {
  const currentPtrPath = opts.currentPtr;
  if (!currentPtrPath) {
    throw new Error("fileTransport: opts.currentPtr is required");
  }

  let fileStream = null;
  let activeDest = null;

  function readCurrentDest() {
    try {
      return readFileSync(currentPtrPath, "utf8").trim() || null;
    } catch {
      return null;
    }
  }

  // Open (or reopen) the write stream if .current has changed.
  function ensureStream() {
    const dest = readCurrentDest();
    if (dest === activeDest) return fileStream;
    if (fileStream) fileStream.end();
    activeDest = dest;
    fileStream = dest ? createWriteStream(dest, { flags: "a", encoding: "utf8" }) : null;
    return fileStream;
  }

  // Poll every 2 s so the worker picks up a new log file when the API server restarts.
  /* global setInterval, clearInterval */
  const pollInterval = setInterval(ensureStream, 2000);

  return abstractTransport(function (source) {
    source.on("data", function (obj) {
      const stream = ensureStream();
      if (stream) stream.write(formatLine(obj));
    });
    source.on("end", function () {
      clearInterval(pollInterval);
      if (fileStream) fileStream.end();
    });
  });
}
