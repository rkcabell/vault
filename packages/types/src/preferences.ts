export type LightTheme = "default" | "latte" | "sandstone" | "mist" | "lavender" | "dream" | "cotton-candy" | "mint" | "garden";
export type DarkTheme = "new-moon" | "matrix" | "charcoal" | "solarized";

export type Preferences = {
  libraryViewMode: "grid" | "list";
  libraryGridCols: 4 | 5 | 6 | 7 | 8;
  libraryIsCompactList: boolean;
  autoTagOnUpload: boolean;
  extractMetadata: boolean;
  detectDuplicates: boolean;
  lowMemoryMode: boolean;
  autoUnpackArchives: boolean;
  hideUnpackedItems: boolean;
  ignoreHiddenFiles: boolean;
  soonWindowDays: number;
  themePreference: "system" | "light" | "dark";
  yellowHighlight: boolean;
  lightTheme: LightTheme;
  darkTheme: DarkTheme;
  exploreBucketColors: Record<string, string>;
  /** Absolute directories Vault may index in place. Empty = feature disabled. */
  indexAllowedRoots: string[];
  /** File extensions (lowercase, no dot) skipped during in-place indexing. */
  indexBlacklistExtensions: string[];
  /** Absolute folders (and everything beneath them) excluded from in-place
   *  indexing even when they sit under an allowed root — e.g. @eaDir, .immich. */
  indexExcludeFolders: string[];
  /** Skip build/dependency bloat during in-place indexing: dependency/build
   *  directories (node_modules, dist, .git…) and non-content file types
   *  (binaries, source code, build artifacts). Documents/images/media stay. */
  indexSkipNonContent: boolean;
  /** How long after a file disappears Vault still treats a matching new file as
   *  that same item moved or renamed, rather than a new one. Moves arrive as an
   *  unrelated unlink + add pair, and a directory move spreads that pair over
   *  however long the OS takes to drain the events. */
  moveDetectionWindowSeconds: number;
  /** How long a missing item is kept before it is deleted for real. Until then
   *  it stays in the library (flagged missing) with all its tags and metadata,
   *  so an unmounted drive or a slow move never costs the user anything. */
  missingFileGraceDays: number;
};

export const DEFAULT_PREFERENCES: Preferences = {
  libraryViewMode: "grid",
  libraryGridCols: 5,
  libraryIsCompactList: false,
  autoTagOnUpload: true,
  extractMetadata: true,
  detectDuplicates: false,
  lowMemoryMode: false,
  autoUnpackArchives: false,
  hideUnpackedItems: false,
  ignoreHiddenFiles: true,
  soonWindowDays: 7,
  themePreference: "system",
  yellowHighlight: false,
  lightTheme: "default",
  darkTheme: "new-moon",
  exploreBucketColors: {},
  indexAllowedRoots: [],
  indexBlacklistExtensions: [],
  indexExcludeFolders: [],
  indexSkipNonContent: true,
  moveDetectionWindowSeconds: 120,
  missingFileGraceDays: 7,
};
