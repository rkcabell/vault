"use client";

import { useCallback, useSyncExternalStore } from "react";
import { apiFetch } from "@/lib/apiFetch";
import { type Preferences, type LightTheme, type DarkTheme, DEFAULT_PREFERENCES } from "@vault/types";

export type { LightTheme, DarkTheme, Preferences };
export { DEFAULT_PREFERENCES };

const LS_KEYS: Partial<Record<keyof Preferences, string>> = {
  libraryViewMode: "library:viewMode",
  libraryGridCols: "library:gridCols",
  libraryIsCompactList: "library:isCompactList",
  autoTagOnIngest: "prefs:autoTagOnIngest",
  extractMetadata: "prefs:extractMetadata",
  detectDuplicates: "prefs:detectDuplicates",
  lowMemoryMode: "prefs:lowMemoryMode",
  autoUnpackArchives: "prefs:autoUnpackArchives",
  hideUnpackedItems: "prefs:hideUnpackedItems",
  ignoreHiddenFiles: "prefs:ignoreHiddenFiles",
  soonWindowDays: "prefs:soonWindowDays",
  themePreference: "prefs:themePreference",
  yellowHighlight: "prefs:yellowHighlight",
  lightTheme: "prefs:lightTheme",
  darkTheme: "prefs:darkTheme",
  ocrMode: "prefs:ocrMode",
  ocrTimeoutCapMinutes: "prefs:ocrTimeoutCapMinutes",
  sidecarMode: "prefs:sidecarMode",
};

// Keys whose values are JSON objects rather than scalars.
const LS_JSON_KEYS: Partial<Record<keyof Preferences, string>> = {
  exploreBucketColors: "prefs:exploreBucketColors",
};

// Superseded localStorage keys, read as a fallback and deleted on the next
// write of their replacement. Without this a renamed preference silently reverts
// to its default on the first load after the rename, before /api/init lands.
const LS_LEGACY_KEYS: Partial<Record<keyof Preferences, string>> = {
  autoTagOnIngest: "prefs:autoTagOnUpload",
};

function readFromLocalStorage(): Partial<Preferences> {
  const out: Partial<Preferences> = {};
  try {
    for (const [key, lsKey] of Object.entries(LS_KEYS) as [keyof Preferences, string][]) {
      const legacyKey = LS_LEGACY_KEYS[key];
      const raw = localStorage.getItem(lsKey)
        ?? (legacyKey ? localStorage.getItem(legacyKey) : null);
      if (raw === null) continue;
      const defaultVal = DEFAULT_PREFERENCES[key];
      if (typeof defaultVal === "boolean") {
        (out as Record<string, unknown>)[key] = raw === "true";
      } else if (typeof defaultVal === "number") {
        const n = Number(raw);
        if (!isNaN(n)) (out as Record<string, unknown>)[key] = n;
      } else {
        (out as Record<string, unknown>)[key] = raw;
      }
    }
    // Post-validate values that have restricted allowlists or ranges
    if (out.libraryViewMode !== undefined && !["grid", "list"].includes(out.libraryViewMode)) delete out.libraryViewMode;
    if (out.libraryGridCols !== undefined && ![4, 5, 6, 7, 8].includes(out.libraryGridCols)) delete out.libraryGridCols;
    if (out.soonWindowDays !== undefined && (out.soonWindowDays < 2 || out.soonWindowDays > 14)) delete out.soonWindowDays;
    if (out.ocrTimeoutCapMinutes !== undefined && (out.ocrTimeoutCapMinutes < 1 || out.ocrTimeoutCapMinutes > 60)) delete out.ocrTimeoutCapMinutes;
    if (out.themePreference !== undefined && !["system", "light", "dark"].includes(out.themePreference)) delete out.themePreference;
    if (out.lightTheme !== undefined && !["default", "latte", "sandstone", "mist", "lavender", "dream", "cotton-candy", "mint", "garden"].includes(out.lightTheme)) delete out.lightTheme;
    if (out.darkTheme !== undefined && !["new-moon", "matrix", "charcoal", "solarized"].includes(out.darkTheme)) delete out.darkTheme;
    if (out.sidecarMode !== undefined && !["off", "snapshot"].includes(out.sidecarMode)) delete out.sidecarMode;

    for (const [key, lsKey] of Object.entries(LS_JSON_KEYS) as [keyof Preferences, string][]) {
      const raw = localStorage.getItem(lsKey);
      if (raw === null) continue;
      try { (out as Record<string, unknown>)[key] = JSON.parse(raw); } catch { /* ignore */ }
    }
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
      const legacyKey = LS_LEGACY_KEYS[key];
      if (legacyKey) localStorage.removeItem(legacyKey);
    }
    for (const [key, lsKey] of Object.entries(LS_JSON_KEYS) as [keyof Preferences, string][]) {
      if (!(key in patch)) continue;
      localStorage.setItem(lsKey, JSON.stringify(patch[key]));
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
  apiFetch("/api/preferences", {
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
