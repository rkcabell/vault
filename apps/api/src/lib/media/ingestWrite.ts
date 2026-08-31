import { createWriteStream } from "node:fs";
import { open, unlink } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * Writes a file sent over HTTP into one of the user's own folders. This is the
 * only place Vault writes into a directory the user owns, so it holds to two
 * rules: it never overwrites an existing file, and it never leaves a partial one
 * behind.
 */

/** Signals that a sent filename cannot be made safe to write. */
export class UnsafeIngestFilenameError extends Error {
  code = "UNSAFE_INGEST_FILENAME";
  constructor (name: string) {
    super(`Unusable filename: ${name}`);
    this.name = "UnsafeIngestFilenameError";
  }
}

/** Signals that the stream crossed `maxBytes` before it finished writing. It
 *  carries the same `code` as ingestService's IngestTooLargeError, so a caller
 *  can branch on `.code` across both. */
export class IngestStreamTooLargeError extends Error {
  code = "INGEST_TOO_LARGE";
  constructor (message: string) {
    super(message);
    this.name = "IngestStreamTooLargeError";
  }
}

/** How many ` (n)` variants to try before giving up on a colliding name. */
const MAX_COLLISION_ATTEMPTS = 500;

/** Control chars, and the set Windows rejects outright — a name carrying one
 *  would fail `open` with an errno the user can do nothing with. */
// eslint-disable-next-line no-control-regex
const ILLEGAL_CHARS = /[\u0000-\u001F<>:"|?*]/g;

/** Names Windows reserves for devices. */
const RESERVED_DEVICE_NAMES = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);

/**
 * Reduces a client-supplied name to a bare filename safe to join onto a
 * directory. Both separators are stripped whatever the platform: a POSIX server
 * must still reject a Windows client's `..\..\etc\passwd`.
 */
export function sanitizeIngestFilename (raw: string): string {
  const flattened = raw.replace(ILLEGAL_CHARS, "").replace(/\\/g, "/");
  // Windows drops a trailing dot or space, so such a name would be stored
  // under a different name than the row records.
  const base = path.posix.basename(flattened).trim().replace(/[. ]+$/, "");
  if (!base || base === "." || base === ".." || path.isAbsolute(base)) {
    throw new UnsafeIngestFilenameError(raw);
  }
  // Reserved with or without an extension, case-insensitively — Windows resolves
  // NUL.txt to the device the same as NUL.
  const dot = base.indexOf(".");
  const stem = dot === -1 ? base : base.slice(0, dot);
  if (RESERVED_DEVICE_NAMES.has(stem.toUpperCase())) {
    throw new UnsafeIngestFilenameError(raw);
  }
  return base;
}

/** `report.pdf` + 2 → `report (2).pdf`. Extension-less names keep their shape. */
export function collisionName (filename: string, attempt: number): string {
  const ext = path.extname(filename);
  const stem = ext ? filename.slice(0, -ext.length) : filename;
  return `${stem} (${attempt})${ext}`;
}

export type IngestWriteResult = {
  /** Absolute path written to. */
  path: string;
  /** Final filename — differs from the requested one when it collided. */
  savedAs: string;
  /** True when a name collision forced a rename. */
  renamed: boolean;
  sizeBytes: number;
  mtimeMs: number;
};

/** Rejects the pipeline once the bytes seen cross `maxBytes`, while the body is
 *  still arriving rather than after all of it has been written. */
function limitBytes (maxBytes: number): Transform {
  let seen = 0;
  return new Transform({
    transform (chunk: Buffer, _encoding, callback) {
      seen += chunk.length;
      if (seen > maxBytes) {
        callback(new IngestStreamTooLargeError(`Exceeds the ${maxBytes} byte limit while streaming`));
        return;
      }
      callback(null, chunk);
    },
  });
}

/**
 * Streams `body` into `folder` under `filename`, or the first free ` (n)`
 * variant of it.
 *
 * The file is opened `wx`, so the name is claimed by the same syscall that
 * checks it: two concurrent sends of one filename cannot both win, and an
 * existing file is never truncated. It is written under its final name rather
 * than a temporary one, because a temp file in a watched folder is indexed as an
 * item of its own. `maxBytes` caps the bytes written, rather than trusting a
 * claimed Content-Length.
 */
export async function writeIngestFile (
  folder: string,
  filename: string,
  body: Readable,
  maxBytes?: number,
): Promise<IngestWriteResult> {
  const safeName = sanitizeIngestFilename(filename);

  let handle;
  let savedAs = safeName;
  let attempt = 1;
  for (;;) {
    try {
      handle = await open(path.join(folder, savedAs), "wx");
      break;
    } catch (err) {
      if ((err as { code?: string }).code !== "EEXIST") throw err;
      attempt += 1;
      if (attempt > MAX_COLLISION_ATTEMPTS) {
        throw new Error(`Too many files named like ${safeName} in ${folder}`);
      }
      savedAs = collisionName(safeName, attempt);
    }
  }

  const full = path.join(folder, savedAs);
  try {
    const dest = createWriteStream(full, { fd: handle.fd, autoClose: false });
    if (maxBytes != null) {
      await pipeline(body, limitBytes(maxBytes), dest);
    } else {
      await pipeline(body, dest);
    }
    const stat = await handle.stat();
    await handle.close();
    return {
      path: full,
      savedAs,
      renamed: savedAs !== safeName,
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
    };
  } catch (err) {
    // An aborted send must not leave a truncated file in the user's folder for
    // the watcher to index. Safe to remove: `wx` proves we created it.
    await handle.close().catch(() => {});
    await unlink(full).catch(() => {});
    throw err;
  }
}
