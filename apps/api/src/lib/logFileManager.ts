import fs from "node:fs";
import path from "node:path";

const LOGS_DIR = path.join(process.cwd(), "logs");
export const CURRENT_PTR = path.join(LOGS_DIR, ".current");
const MAX_LOGS = 10;

/** Called once at server startup. Creates a timestamped log file, rotates old ones,
 *  and writes a .current pointer so the worker process can find the same file. */
export function initLogFile (): string {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  rotateLogs();
  const timestamp = new Date().toISOString().replace(/:/g, "-").replace("T", "_").slice(0, 19);
  const logFile = path.join(LOGS_DIR, `${timestamp}.log`);
  fs.writeFileSync(logFile, buildLogHeader(), "utf8");
  fs.writeFileSync(CURRENT_PTR, logFile, "utf8");
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
 *  Returns null if the server hasn't started yet. */
export function getActiveLogFile (): string | null {
  try {
    const p = fs.readFileSync(CURRENT_PTR, "utf8").trim();
    return p || null;
  } catch {
    return null;
  }
}

function rotateLogs (): void {
  if (!fs.existsSync(LOGS_DIR)) return;
  const files = fs
    .readdirSync(LOGS_DIR)
    .filter(f => f.endsWith(".log"))
    .map(f => ({ fullPath: path.join(LOGS_DIR, f), mtime: fs.statSync(path.join(LOGS_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime); // newest first
  // Delete oldest, keeping MAX_LOGS - 1 to make room for the new file
  for (const file of files.slice(MAX_LOGS - 1)) {
    fs.unlinkSync(file.fullPath);
  }
}
