import fs from "node:fs";
import path from "node:path";

const DEFAULT_LOGS_DIR = path.join(process.cwd(), "logs");
export const CURRENT_PTR = path.join(DEFAULT_LOGS_DIR, ".current");
const MAX_LOGS = 10;

/** Called once at server startup. Creates a timestamped log file, rotates old ones,
 *  and writes a .current pointer so the worker process can find the same file.
 *  Pass logsDir to override the default directory (useful for isolated tests). */
export function initLogFile (logsDir = DEFAULT_LOGS_DIR): string {
  fs.mkdirSync(logsDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/:/g, "-").replace("T", "_").slice(0, 19);
  const logFile = path.join(logsDir, `${timestamp}.log`);
  fs.writeFileSync(logFile, buildLogHeader(), "utf8");
  fs.writeFileSync(path.join(logsDir, ".current"), logFile, "utf8");
  rotateLogs(logsDir);
  return logFile;
}

function buildLogHeader (): string {
  const W      = 80;
  const inner  = W - 2;
  const prefix = "  DATE    TIME      SRC     LEVEL   MESSAGE";
  const suffix = "EXTRAS   ══";
  const gap    = " ".repeat(inner - prefix.length - suffix.length);
  return [
    `╔${"═".repeat(inner)}╗`,
    `╠${prefix}${gap}${suffix}╣`,
    `╚${"═".repeat(inner)}╝`,
    "",
    "",
  ].join("\n");
}

/** Called by the worker process to find the server's active log file.
 *  Pass logsDir to match the directory used in initLogFile; defaults to the
 *  same default directory so existing callers don't need to change.
 *  Returns null if the server hasn't started yet. */
export function getActiveLogFile (logsDir = DEFAULT_LOGS_DIR): string | null {
  try {
    const p = fs.readFileSync(path.join(logsDir, ".current"), "utf8").trim();
    return p || null;
  } catch {
    return null;
  }
}

function rotateLogs (logsDir: string): void {
  if (!fs.existsSync(logsDir)) return;
  const files = fs
    .readdirSync(logsDir)
    .filter(f => f.endsWith(".log"))
    .map(f => ({ fullPath: path.join(logsDir, f), mtime: fs.statSync(path.join(logsDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime); // newest first
  // Delete oldest beyond MAX_LOGS
  for (const file of files.slice(MAX_LOGS)) {
    fs.unlinkSync(file.fullPath);
  }
}
