export type LightTheme =
  | 'default'
  | 'latte'
  | 'sandstone'
  | 'mist'
  | 'lavender'
  | 'dream'
  | 'cotton-candy'
  | 'mint'
  | 'garden'
export type DarkTheme = 'new-moon' | 'matrix' | 'charcoal' | 'solarized'

export type Preferences = {
  libraryViewMode: 'grid' | 'list'
  libraryGridCols: 4 | 5 | 6 | 7 | 8
  libraryIsCompactList: boolean
  //                       ^ ^
  //                    >(:^u^:)<
  /** Run _Tag Organizer_  rules at every ingest site (upload, in-place index,
   *  archive unpack). Off means no rule-derived tags, including `source:` —
   *  only what the user typed or the bundle name. Retroactive runs from the
   *  Tag Organizer page ignore this. */
  autoTagOnIngest: boolean
  extractMetadata: boolean
  detectDuplicates: boolean
  lowMemoryMode: boolean
  autoUnpackArchives: boolean
  hideUnpackedItems: boolean
  ignoreHiddenFiles: boolean
  soonWindowDays: number
  themePreference: 'system' | 'light' | 'dark'
  yellowHighlight: boolean
  lightTheme: LightTheme
  darkTheme: DarkTheme
  exploreBucketColors: Record<string, string>
  /** Absolute directories Vault may index in place. Empty = feature disabled. */
  indexAllowedRoots: string[]
  /** File extensions (lowercase, no dot) skipped during in-place indexing. */
  indexBlacklistExtensions: string[]
  /** Absolute folders (and everything beneath them) excluded from in-place
   *  indexing even when they sit under an allowed root — e.g. @eaDir, .immich. */
  indexExcludeFolders: string[]
  /** Skip build/dependency dirs (node_modules, dist, .git…) and non-content
   *  file types (binaries, source, build artifacts) during in-place indexing. */
  indexSkipNonContent: boolean
  /** Where a file sent over HTTP is written — must sit inside an allowed index
   *  root, so a rescan can rediscover it (the point of ingesting here instead
   *  of into managed storage). Null disables sending; no managed-original fallback. */
  ingestFolderPath: string | null
  /** How long after a file disappears Vault still treats a matching new file as
   *  that item moved/renamed rather than new. Moves arrive as an unrelated
   *  unlink+add pair, and a directory move spreads that pair out over time. */
  moveDetectionWindowSeconds: number
  /** How long a missing item is kept (flagged missing, tags/metadata intact)
   *  before deletion — so an unmounted drive or a slow move costs nothing. */
  missingFileGraceDays: number
  /** What to do with scans (no embedded text layer) — the only files needing
   *  Tesseract. Native extraction runs at index time and covers the born-digital
   *  majority in minutes; this governs only the expensive remainder:
   *    onDemand   — extract when the user opens the document or asks. Default.
   *    background — a sweeper works the NEEDS_OCR backlog continuously.
   *    off        — never; the backlog stays visible and can be run manually. */
  ocrMode: OcrMode
  /** Hard ceiling on one tier-2 (Tesseract) OCR job's wall time, in minutes —
   *  ocrmypdf runs as a subprocess pinned near a full core, so an unbounded run
   *  on a huge/corrupt scan would tie up a worker slot indefinitely. */
  ocrTimeoutCapMinutes: number
  /** Whether Vault periodically snapshots every item's tags, title, starred
   *  state, fileDate, bundles and reminders to managed storage, so a lost
   *  database can be restored. Never writes next to an indexed source file. */
  sidecarMode: SidecarMode
  /** How often this user's snapshot is taken, in minutes. One process-wide
   *  timer serves every user, so this can only lengthen the interval, never
   *  shorten it below SIDECAR_EXPORT_INTERVAL_MS. */
  sidecarIntervalMinutes: SidecarIntervalMinutes
}

/** @see Preferences.ocrMode */
export type OcrMode = 'onDemand' | 'background' | 'off'

/** @see Preferences.sidecarMode */
export type SidecarMode = 'off' | 'snapshot'

/** @see Preferences.sidecarIntervalMinutes */
export type SidecarIntervalMinutes = 5 | 15 | 60 | 360 | 1440

export const DEFAULT_PREFERENCES: Preferences = {
  libraryViewMode: 'grid',
  libraryGridCols: 5,
  libraryIsCompactList: false,
  autoTagOnIngest: true,
  extractMetadata: true,
  detectDuplicates: false,
  lowMemoryMode: false,
  autoUnpackArchives: false,
  hideUnpackedItems: false,
  ignoreHiddenFiles: true,
  soonWindowDays: 7,
  themePreference: 'system',
  yellowHighlight: false,
  lightTheme: 'default',
  darkTheme: 'new-moon',
  exploreBucketColors: {},
  indexAllowedRoots: [],
  indexBlacklistExtensions: [],
  indexExcludeFolders: [],
  indexSkipNonContent: true,
  ingestFolderPath: null,
  moveDetectionWindowSeconds: 120,
  missingFileGraceDays: 7,
  ocrMode: 'onDemand',
  // Matches the previous hardcoded cap, so existing installs see no behavior
  // change until someone opts to raise or lower it.
  ocrTimeoutCapMinutes: 10,
  sidecarMode: 'snapshot',
  sidecarIntervalMinutes: 5
}

/** Preference keys renamed in place, old → current. Drop an entry once no
 *  install can still be holding the old key. */
const RENAMED_KEYS: Record<string, keyof Preferences> = {
  autoTagOnUpload: 'autoTagOnIngest'
}

/**
 * Rewrite legacy keys in a stored preferences blob to current names. The
 * current key wins if both are present; non-object input yields `{}`. Every
 * read/merge path goes through this — the data migration only fixed rows
 * present when it ran, so a restored dump or stale localStorage copy can
 * still carry an old key.
 */
export function normalizePreferenceKeys (raw: unknown): Partial<Preferences> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out = { ...(raw as Record<string, unknown>) }
  for (const [legacy, current] of Object.entries(RENAMED_KEYS)) {
    if (!(legacy in out)) continue
    if (!(current in out)) out[current] = out[legacy]
    delete out[legacy]
  }
  return out as Partial<Preferences>
}
