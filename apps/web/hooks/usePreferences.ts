"use client";

import { useCallback, useSyncExternalStore } from "react";

export type LightTheme = "default" | "latte" | "sandstone" | "mist" | "lavender" | "dream" | "cotton-candy" | "mint" | "garden";
export type DarkTheme = "new-moon" | "matrix" | "charcoal" | "solarized";

export type Preferences = {
  libraryViewMode: "grid" | "list";
  libraryGridCols: 4 | 5 | 6 | 7 | 8;
  libraryIsCompactList: boolean;
  autoTagOnUpload: boolean;
  extractMetadata: boolean;
  detectDuplicates: boolean;
  collapseMetadataByDefault: boolean;
  lowMemoryMode: boolean;
  autoUnpackArchives: boolean;
  hideUnpackedItems: boolean;
  soonWindowDays: number;
  themePreference: "system" | "light" | "dark";
  lightTheme: LightTheme;
  darkTheme: DarkTheme;
};

export const DEFAULT_PREFERENCES: Preferences = {
  libraryViewMode: "grid",
  libraryGridCols: 5,
  libraryIsCompactList: false,
  autoTagOnUpload: true,
  extractMetadata: true,
  detectDuplicates: false,
  collapseMetadataByDefault: true,
  lowMemoryMode: false,
  autoUnpackArchives: false,
  hideUnpackedItems: false,
  soonWindowDays: 7,
  themePreference: "system",
  lightTheme: "default",
  darkTheme: "new-moon",
};

const LS_KEYS: Partial<Record<keyof Preferences, string>> = {
  libraryViewMode: "library:viewMode",
  libraryGridCols: "library:gridCols",
  libraryIsCompactList: "library:isCompactList",
  autoTagOnUpload: "prefs:autoTagOnUpload",
  extractMetadata: "prefs:extractMetadata",
  detectDuplicates: "prefs:detectDuplicates",
  collapseMetadataByDefault: "prefs:collapseMetadataByDefault",
  lowMemoryMode: "prefs:lowMemoryMode",
  autoUnpackArchives: "prefs:autoUnpackArchives",
  hideUnpackedItems: "prefs:hideUnpackedItems",
  soonWindowDays: "prefs:soonWindowDays",
  themePreference: "prefs:themePreference",
  lightTheme: "prefs:lightTheme",
  darkTheme: "prefs:darkTheme",
};

function readFromLocalStorage(): Partial<Preferences> {
  const out: Partial<Preferences> = {};
  try {
    const viewMode = localStorage.getItem("library:viewMode");
    if (viewMode === "grid" || viewMode === "list") out.libraryViewMode = viewMode;

    const gridCols = Number(localStorage.getItem("library:gridCols"));
    if ([4, 5, 6, 7, 8].includes(gridCols)) out.libraryGridCols = gridCols as Preferences["libraryGridCols"];

    const compactList = localStorage.getItem("library:isCompactList");
    if (compactList !== null) out.libraryIsCompactList = compactList === "true";

    const autoTag = localStorage.getItem("prefs:autoTagOnUpload");
    if (autoTag !== null) out.autoTagOnUpload = autoTag === "true";

    const extractMeta = localStorage.getItem("prefs:extractMetadata");
    if (extractMeta !== null) out.extractMetadata = extractMeta === "true";

    const detectDups = localStorage.getItem("prefs:detectDuplicates");
    if (detectDups !== null) out.detectDuplicates = detectDups === "true";

    const collapseMeta = localStorage.getItem("prefs:collapseMetadataByDefault");
    if (collapseMeta !== null) out.collapseMetadataByDefault = collapseMeta === "true";

    const lowMemory = localStorage.getItem("prefs:lowMemoryMode");
    if (lowMemory !== null) out.lowMemoryMode = lowMemory === "true";

    const autoUnpack = localStorage.getItem("prefs:autoUnpackArchives");
    if (autoUnpack !== null) out.autoUnpackArchives = autoUnpack === "true";

    const hideZip = localStorage.getItem("prefs:hideUnpackedItems");
    if (hideZip !== null) out.hideUnpackedItems = hideZip === "true";

    const soonWindowDays = Number(localStorage.getItem("prefs:soonWindowDays"));
    if (soonWindowDays >= 2 && soonWindowDays <= 14) out.soonWindowDays = soonWindowDays;

    const theme = localStorage.getItem("prefs:themePreference");
    if (theme === "system" || theme === "light" || theme === "dark") out.themePreference = theme;

    const lightTheme = localStorage.getItem("prefs:lightTheme");
    if (lightTheme === "default" || lightTheme === "latte" || lightTheme === "sandstone" || lightTheme === "mist" || lightTheme === "lavender" || lightTheme === "dream" || lightTheme === "cotton-candy" || lightTheme === "mint" || lightTheme === "garden") out.lightTheme = lightTheme;

    const darkTheme = localStorage.getItem("prefs:darkTheme");
    if (darkTheme === "new-moon" || darkTheme === "matrix" || darkTheme === "charcoal" || darkTheme === "solarized") out.darkTheme = darkTheme;
  } catch {
    // ignore
  }
  return out;
}

function syncToLocalStorage(patch: Partial<Preferences>) {
  try {
    for (const [key, lsKey] of Object.entries(LS_KEYS) as [keyof Preferences, string][]) {
      if (!(key in patch)) continue;
      localStorage.setItem(lsKey, String(patch[key]));
    }
  } catch {
    // ignore
  }
}

// --- Module-level singleton store ---
// Shared across all usePreferences() instances in the same browser tab so that
// a preference update in one component (e.g. SettingsPage) is immediately
// reflected in every other consumer (e.g. ThemeApplier, LibraryPageInner).

let _prefs: Preferences = DEFAULT_PREFERENCES;
let _isLoaded = false;
let _initialized = false;
const _listeners = new Set<() => void>();
let _savePatch: Partial<Preferences> = {};
let _saveTimer: ReturnType<typeof setTimeout> | null = null;

function _flushSave() {
  if (!Object.keys(_savePatch).length) return;
  const patch = _savePatch;
  _savePatch = {};
  fetch("/api/preferences", {
    method: "PATCH",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  }).catch(() => {});
}

function _debouncedSave(patch: Partial<Preferences>) {
  _savePatch = { ..._savePatch, ...patch };
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => { _saveTimer = null; _flushSave(); }, 600);
}

function _notify() {
  _listeners.forEach(fn => fn());
}

function _set(patch: Partial<Preferences>) {
  _prefs = { ..._prefs, ...patch };
  _notify();
}

function _initOnce() {
  if (_initialized) return;
  _initialized = true;

  // 1. Instant init from localStorage
  const cached = readFromLocalStorage();
  if (Object.keys(cached).length > 0) {
    _prefs = { ..._prefs, ...cached };
    // no notify needed — listeners haven't subscribed yet on first init
  }

  // API fetch is handled exclusively by useAppInit → hydratePreferences().
  // Mark loaded immediately so components get localStorage values right away.
  _isLoaded = true;
}

/** Called by useAppInit to hydrate from the batched /api/init response. */
export function hydratePreferences(prefs: Partial<Preferences>) {
  _initialized = true;
  _isLoaded = true;
  _prefs = { ..._prefs, ...prefs };
  syncToLocalStorage(prefs);
  _notify();
}

function _subscribe(callback: () => void) {
  _listeners.add(callback);
  return () => { _listeners.delete(callback); };
}

function _getSnapshot() {
  if (!_initialized) _initOnce();
  return _prefs;
}

function _getServerSnapshot() {
  return DEFAULT_PREFERENCES;
}

export function usePreferences() {
  const prefs = useSyncExternalStore(_subscribe, _getSnapshot, _getServerSnapshot);

  const updatePreferences = useCallback((patch: Partial<Preferences>) => {
    _set(patch);
    syncToLocalStorage(patch);
    _debouncedSave(patch); // batches rapid slider changes; flushes 600ms after last call
  }, []);

  return { prefs, isLoaded: _isLoaded, updatePreferences };
}
