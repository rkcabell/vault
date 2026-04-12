import pino, { type Logger, type LoggerOptions } from "pino";
import { CURRENT_PTR } from "./logFileManager.js";

export const PRETTY_OPTS = {
  translateTime: "SYS:HH:MM:ss",
  singleLine: true,
  ignore: "pid,hostname,level",
};

// Absolute file:// URL so pino's worker thread can import this without tsx.
// Only used in dev — in production the process logs to stdout.
const FILE_TRANSPORT_URL = new URL("./fileTransport.mjs", import.meta.url).href;

/** Returns the pino transport targets for dev. Empty in production — callers
 *  should omit the transport option entirely so pino defaults to stdout. */
export function buildTransportTargets (level = "info") {
  if (isProd) return [];
  return [
    { target: "pino-pretty", options: { ...PRETTY_OPTS, colorize: true }, level },
    { target: FILE_TRANSPORT_URL, options: { currentPtr: CURRENT_PTR }, level },
  ];
}

// Fields stripped before any transport sees the log line.
// Keeps output readable without hiding genuinely useful context.
const STRIP_FIELDS = new Set([
  "queue",       // redundant — jobName already identifies the worker type
  "userId",      // long UUID, PII
  "jobId",       // long opaque string
  "key",         // S3 object key — verbose path
  "mimeType",
  "attempt",
  "timeoutMs",
  "forceOcr",
  "ocrPdfBytes",
]);

export const LOG_FORMATTERS: LoggerOptions["formatters"] = {
  log (obj) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (STRIP_FIELDS.has(k)) continue;
      // Truncate UUID-like IDs to the first segment for readability
      if (k === "mediaId" && typeof v === "string") {
        out[k] = v.split("-")[0];
      } else {
        out[k] = v;
      }
    }
    return out;
  },
};

const level = process.env.LOG_LEVEL ?? "info";
const isTest = process.env.NODE_ENV === "test";
const isProd = process.env.NODE_ENV === "production";

export function createLogger (name?: string): Logger {
  const options: LoggerOptions = {
    level,
    base: name !== undefined ? { name } : null,
    messageKey: "message",
    formatters: LOG_FORMATTERS,
    serializers: { err: pino.stdSerializers.err },
  };

  if (isTest || isProd) {
    return pino(options); // stdout JSON — no transport in tests or prod Docker
  }

  options.transport = { targets: buildTransportTargets(level) };

  return pino(options);
}
