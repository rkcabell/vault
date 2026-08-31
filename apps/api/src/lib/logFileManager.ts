/**
 * Creates the log file a server run writes to, and keeps the log directory
 * from growing without limit.
 *
 * The server and the worker are separate processes, so the server records the
 * file it chose in a `.current` pointer that the worker reads.
 */
import fs from "node:fs";
import path from "node:path";

const DEFAULT_LOGS_DIR = path.join(process.cwd(), "logs");
export const CURRENT_PTR = path.join(DEFAULT_LOGS_DIR, ".current");
const MAX_LOGS = 10;

/**
 * Starts a new log file for this server run and returns its path.
 *
 * Writes the `.current` pointer, then deletes the oldest files beyond the
 * retention limit. Pass `logsDir` to keep a test out of the real log directory.
 */
export function initLogFile (logsDir = DEFAULT_LOGS_DIR): string {
  fs.mkdirSync(logsDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/:/g, "-").replace("T", "_").slice(0, 19);
  const logFile = path.join(logsDir, `${timestamp}.log`);
  fs.writeFileSync(logFile, buildLogHeader(), "utf8");
  fs.writeFileSync(path.join(logsDir, ".current"), logFile, "utf8");
  rotateLogs(logsDir);
  return logFile;
}

// Draws the boxed column headings at the top of a log file.
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

/**
 * Returns the log file the server is currently writing to, or null if no
 * server has started since the log directory was last cleared.
 *
 * Pass the same `logsDir` that {@link initLogFile} was given.
 */
export function getActiveLogFile (logsDir = DEFAULT_LOGS_DIR): string | null {
  try {
    const p = fs.readFileSync(path.join(logsDir, ".current"), "utf8").trim();
    return p || null;
  } catch {
    return null;
  }
}

// Deletes the oldest log files, keeping the MAX_LOGS most recently written.
function rotateLogs (logsDir: string): void {
  if (!fs.existsSync(logsDir)) return;
  const files = fs
    .readdirSync(logsDir)
    .filter(f => f.endsWith(".log"))
    .map(f => ({ fullPath: path.join(logsDir, f), mtime: fs.statSync(path.join(logsDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime); // newest first
  for (const file of files.slice(MAX_LOGS)) {
    fs.unlinkSync(file.fullPath);
  }
}
