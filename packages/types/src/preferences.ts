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
};
