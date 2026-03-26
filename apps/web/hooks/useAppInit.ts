"use client";

import { useEffect, useState } from "react";
import { hydratePreferences, type Preferences } from "./usePreferences";
import { seedRemindersSummary, seedOverviewReminders } from "../lib/reminders";
import type { RemindersSummary, ReminderOverviewRow } from "@vault/types";
import type { BundleListItem } from "@vault/types";

export type InitUser = {
  id: string;
  email: string;
  name?: string | null;
  username?: string | null;
  avatarUrl?: string | null;
};

export type InitTag = { name: string; count: number; color: string | null };

export type AppInitData = {
  user: InitUser | null;
  preferences: Preferences;
  tags: InitTag[];
  bundles: BundleListItem[];
  remindersSummary: RemindersSummary;
  overviewReminders: { items: ReminderOverviewRow[] };
};

// --- Module-level singleton ---

let _data: AppInitData | null = null;
let _isLoaded = false;
let _initialized = false;
let _unauthenticated = false;
const _listeners = new Set<() => void>();

function _notify() {
  _listeners.forEach(fn => fn());
}

function _initOnce() {
  if (_initialized) return;
  _initialized = true;

  fetch("/api/init", { credentials: "include" })
    .then(r => {
      if (r.ok) return r.json() as Promise<AppInitData>;
      if (r.status === 401) _unauthenticated = true;
      return null;
    })
    .then((data: AppInitData | null) => {
      if (!data) return;
      _data = data;
      hydratePreferences(data.preferences);
      seedRemindersSummary(data.remindersSummary);
      seedOverviewReminders(data.overviewReminders.items, data.preferences.soonWindowDays ?? 7);
    })
    .catch(() => {})
    .finally(() => {
      _isLoaded = true;
      _notify();
    });
}

export function useAppInit() {
  const [, rerender] = useState(0);

  // Called in render body (not just on mount) so a reset → re-render triggers
  // a fresh fetch for the newly logged-in user without needing a full page reload.
  _initOnce();

  useEffect(() => {
    const listener = () => rerender(n => n + 1);
    _listeners.add(listener);
    rerender(n => n + 1);
    return () => { _listeners.delete(listener); };
  }, []);

  return { data: _data, isLoaded: _isLoaded, unauthenticated: _unauthenticated };
}

/** Resets all singleton state — call on logout so the next login gets a fresh fetch. */
export function resetAppInit() {
  _data = null;
  _isLoaded = false;
  _initialized = false;
  _unauthenticated = false;
  _notify();
}

/** Synchronous accessor for other modules that don't need reactivity. */
export function getAppInitData() { return _data; }
export function isAppInitLoaded() { return _isLoaded; }
