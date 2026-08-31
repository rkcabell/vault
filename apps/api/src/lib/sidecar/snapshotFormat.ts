import type { Readable } from "node:stream";
import {
  SIDECAR_SCHEMA_VERSION,
  type SidecarEntry,
  type SidecarSnapshotHeader,
  type SidecarTagLine,
} from "@vault/types";

/**
 * Format for the library snapshot on disk. Contains a header line giving the
 * schema version, the user, and when the export ran; a line listing every tag
 * with its colour; then one line per media row. Each line is its own JSON
 * document, so the file can be read one line at a time and a line that fails to
 * parse loses only its own row.
 */

/** Returns the storage key for one user's snapshot file. */
export function snapshotKey (userId: string): string {
  return `sidecars/${userId}/library-snapshot.jsonl`;
}

/** Returns the storage key for the previous snapshot. */
export function snapshotBackupKey (userId: string): string {
  return `${snapshotKey(userId)}.bak`;
}

export function encodeHeader (userId: string, exportedAt: Date, entries: number): string {
  const header: SidecarSnapshotHeader = {
    kind: "vault-library-snapshot",
    schemaVersion: SIDECAR_SCHEMA_VERSION,
    userId,
    exportedAt: exportedAt.toISOString(),
    entries,
  };
  return `${JSON.stringify(header)}\n`;
}

/** Returns one media row as a snapshot line. Every field omitted here must be
 *  one that `toEntry` can rebuild. */
export function encodeEntry (entry: SidecarEntry): string {
  const line: Partial<SidecarEntry> = {
    id: entry.id,
    ...(entry.sourcePath !== null && { sourcePath: entry.sourcePath }),
    filename: entry.filename,
    mimeType: entry.mimeType,
    sizeBytes: entry.sizeBytes,
    ...(entry.contentHash !== null && { contentHash: entry.contentHash }),
    title: entry.title,
    ...(entry.titleIsUserEdited && { titleIsUserEdited: true }),
    ...(entry.tags.length > 0 && { tags: entry.tags }),
    ...(entry.starred && { starred: true }),
    ...(entry.starredAt !== null && { starredAt: entry.starredAt }),
    ...(entry.fileDate !== null && { fileDate: entry.fileDate }),
    ...(entry.bundles.length > 0 && { bundles: entry.bundles }),
    ...(entry.reminders.length > 0 && { reminders: entry.reminders }),
  };
  return `${JSON.stringify(line)}\n`;
}

export function encodeTagLine (tags: SidecarTagLine["tags"]): string {
  return `${JSON.stringify({ kind: "tags", tags } satisfies SidecarTagLine)}\n`;
}

/** Marks a failure to read a snapshot file. */
export class SidecarFormatError extends Error {
  code = "SIDECAR_FORMAT";
  constructor (message: string) {
    super(message);
    this.name = "SidecarFormatError";
  }
}

/** Reads and validates the snapshot's header line. Throws `SidecarFormatError`
 *  for a file that is not a Vault snapshot, or whose schema version is newer
 *  than this build. */
export function parseHeader (line: string): SidecarSnapshotHeader {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    throw new SidecarFormatError("snapshot header is not valid JSON");
  }
  const header = raw as Partial<SidecarSnapshotHeader>;
  if (header?.kind !== "vault-library-snapshot") {
    throw new SidecarFormatError("not a Vault library snapshot");
  }
  if (typeof header.schemaVersion !== "number" || header.schemaVersion > SIDECAR_SCHEMA_VERSION) {
    throw new SidecarFormatError(
      `snapshot schema version ${String(header.schemaVersion)} is newer than this build understands (${SIDECAR_SCHEMA_VERSION})`,
    );
  }
  if (typeof header.userId !== "string" || typeof header.exportedAt !== "string") {
    throw new SidecarFormatError("snapshot header is missing userId or exportedAt");
  }
  return { ...header, entries: typeof header.entries === "number" ? header.entries : 0 } as SidecarSnapshotHeader;
}

/** Kind of line read from a snapshot. `unknown` covers a line that failed to
 *  parse and a line a newer build wrote; both are skipped. */
export type SidecarLine =
  | { type: "entry"; entry: SidecarEntry }
  | { type: "tags"; tags: SidecarTagLine["tags"] }
  | { type: "unknown" };

/** Classifies one line from a snapshot file. Never throws; an unreadable line
 *  comes back as `unknown`. */
export function parseLine (line: string): SidecarLine {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { type: "unknown" };
  }
  if (!raw || typeof raw !== "object") return { type: "unknown" };

  if ((raw as SidecarTagLine).kind === "tags") {
    const tags = (raw as SidecarTagLine).tags;
    if (!Array.isArray(tags)) return { type: "unknown" };
    return {
      type: "tags",
      tags: tags
        .filter((t): t is SidecarTagLine["tags"][number] => !!t && typeof (t as { name?: unknown }).name === "string")
        .map(t => ({
          name: t.name,
          color: typeof t.color === "string" ? t.color : null,
          origin: t.origin === "AUTO" ? "AUTO" : "USER",
        })),
    };
  }

  const entry = toEntry(raw);
  return entry ? { type: "entry", entry } : { type: "unknown" };
}

/** Rebuilds a media entry from a parsed snapshot line. Returns null when the
 *  line has no id, or has neither `sourcePath` nor `contentHash` to match it
 *  back to a row. Missing optional fields fall back to empty values. */
function toEntry (raw: unknown): SidecarEntry | null {
  const entry = raw as Partial<SidecarEntry>;
  if (typeof entry.id !== "string") return null;
  if (typeof entry.sourcePath !== "string" && typeof entry.contentHash !== "string") return null;
  return {
    id: entry.id,
    sourcePath: typeof entry.sourcePath === "string" ? entry.sourcePath : null,
    filename: typeof entry.filename === "string" ? entry.filename : "",
    mimeType: typeof entry.mimeType === "string" ? entry.mimeType : "",
    sizeBytes: typeof entry.sizeBytes === "number" ? entry.sizeBytes : 0,
    contentHash: typeof entry.contentHash === "string" ? entry.contentHash : null,
    title: typeof entry.title === "string" ? entry.title : "",
    titleIsUserEdited: entry.titleIsUserEdited === true,
    tags: Array.isArray(entry.tags) ? entry.tags.filter((t): t is string => typeof t === "string") : [],
    starred: entry.starred === true,
    starredAt: typeof entry.starredAt === "string" ? entry.starredAt : null,
    fileDate: typeof entry.fileDate === "string" ? entry.fileDate : null,
    bundles: Array.isArray(entry.bundles) ? entry.bundles.filter((b): b is string => typeof b === "string") : [],
    reminders: Array.isArray(entry.reminders) ? entry.reminders.filter(isReminder) : [],
  };
}

function isReminder (value: unknown): value is SidecarEntry["reminders"][number] {
  const r = value as Partial<SidecarEntry["reminders"][number]>;
  return !!r && typeof r === "object" && typeof r.title === "string" && typeof r.dueAt === "string";
}

/** Yields each line of `stream`, trimmed, skipping blank ones. Any trailing
 *  bytes after the last newline are yielded as a final line. */
export async function* readLines (stream: Readable): AsyncGenerator<string> {
  let buffer = "";
  for await (const chunk of stream) {
    buffer += typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8");
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) yield line;
      newline = buffer.indexOf("\n");
    }
  }
  const last = buffer.trim();
  if (last) yield last;
}
