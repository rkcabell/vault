/**
 * Wire types for the library metadata snapshot: everything Vault knows about an
 * item that is *not* recoverable from the file itself. Extracted text is
 * excluded — the only large field and the only regenerable one.
 */

/** Bumped whenever a reader would misinterpret an older file. */
export const SIDECAR_SCHEMA_VERSION = 1;

/** First line of a snapshot file. Its absence means the file isn't ours. */
export type SidecarSnapshotHeader = {
  kind: "vault-library-snapshot";
  schemaVersion: number;
  userId: string;
  exportedAt: string;
  /** Row count when the export started, so a status read costs one header line
   *  instead of a full scan. Approximate by construction — rows can be added
   *  while the export streams — and used for display only, never for control
   *  flow. */
  entries: number;
};

/** The user's tag vocabulary, exported once as its own line rather than per
 *  item: colour and origin belong to the tag name, not to any one media row. */
export type SidecarTagLine = {
  kind: "tags";
  tags: Array<{ name: string; color: string | null; origin: "USER" | "AUTO" }>;
};

export type SidecarReminder = {
  title: string;
  note: string | null;
  dueAt: string;
  remindAt: string;
  timezone: string;
  rrule: string | null;
  remindOffsetDays: number | null;
};

/** One line of a snapshot file, after the header. */
export type SidecarEntry = {
  id: string;
  /** Absolute path of the in-place original; null for a managed upload. Primary
   *  match key on restore, because it survives a database loss and a rescan. */
  sourcePath: string | null;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  /** Fallback match key: identifies the same bytes at a different path. */
  contentHash: string | null;
  title: string;
  /** False means `title` was derived from the filename, so a rescan already
   *  reproduces it and a restore leaves the fresh row's title alone. */
  titleIsUserEdited: boolean;
  tags: string[];
  starred: boolean;
  starredAt: string | null;
  fileDate: string | null;
  /** Bundle names, not ids — ids do not survive the database they came from. */
  bundles: string[];
  reminders: SidecarReminder[];
};

/** Counts from one export pass. */
export type SidecarExportResult = {
  entries: number;
  bytes: number;
  exportedAt: string;
};

/** `matched` = snapshot entries that found a row; `updated` = rows
 *  changed, which is 0 on a re-run. */
export type SidecarRestoreResult = {
  entries: number;
  matched: number;
  updated: number;
  tagsRestored: number;
  bundlesRestored: number;
  remindersRestored: number;
  /** Tag rows whose colour/origin came back from the snapshot's tag line. */
  tagVocabularyRestored: number;
};

/** `interrupted` is never written — it is derived on read from a run still
 *  recorded as "running" with no live process behind it. */
export type SidecarRestoreState =
  | { state: "running"; startedAt: string; processed: number }
  | { state: "done"; finishedAt: string; result: SidecarRestoreResult }
  | { state: "failed"; finishedAt: string; message: string }
  | { state: "interrupted"; startedAt: string; processed: number };

/** What `GET /api/sidecars` reports. */
export type SidecarStatus = {
  /** False when the server was started with SIDECAR_EXPORT_ENABLED=false. The
   *  user's `mode` is still whatever they chose, so reporting only `mode` would
   *  show "On" for a feature that cannot run — report both. */
  enabled: boolean;
  mode: "off" | "snapshot";
  /** Null when no snapshot has been written yet. */
  snapshot: { exportedAt: string; entries: number; sizeBytes: number } | null;
  /** Present while a restore is running or after the most recent one finished. */
  restore: SidecarRestoreState | null;
};
