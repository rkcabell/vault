import type { PreferencesRepository } from "../repositories/preferencesRepository.js";
import { type Preferences, DEFAULT_PREFERENCES, normalizePreferenceKeys } from "@vault/types";

/**
 * Reads and writes a user's preferences, holding each user's set briefly in
 * memory so a hot path does not query for them on every call.
 */

const CACHE_TTL_MS = 60_000;

/** The subset of a user's preferences the index watcher needs to watch + filter. */
export interface IndexConfig {
  userId: string;
  allowedRoots: string[];
  excludeFolders: string[];
  blacklistExtensions: string[];
  ignoreHidden: boolean;
  skipNonContent: boolean;
  /** Seconds a missing file can still be matched to a move. */
  moveDetectionWindowSeconds: number;
  /** Days a missing item is kept before the sweeper deletes it for real. */
  missingFileGraceDays: number;
}

interface CacheEntry {
  value: Preferences;
  expiresAt: number;
}

export class PreferencesService {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly repo: PreferencesRepository) {}

  async getPreferences (userId: string): Promise<Preferences> {
    const cached = this.cache.get(userId);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const raw = await this.repo.getPreferences(userId);
    const value = { ...DEFAULT_PREFERENCES, ...normalizePreferenceKeys(raw) };
    this.cache.set(userId, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    return value;
  }

  /**
   * Returns the indexing config of every user who has at least one allowed root.
   * The live watcher reads it to know which directories to watch. It skips the
   * per-user cache, reading every user in one query.
   */
  async listIndexConfigs (): Promise<IndexConfig[]> {
    const rows = await this.repo.listAll();
    const configs: IndexConfig[] = [];
    for (const row of rows) {
      const prefs = { ...DEFAULT_PREFERENCES, ...normalizePreferenceKeys(row.preferences) };
      if (prefs.indexAllowedRoots.length === 0) continue;
      configs.push({
        userId: row.id,
        allowedRoots: prefs.indexAllowedRoots,
        excludeFolders: prefs.indexExcludeFolders,
        blacklistExtensions: prefs.indexBlacklistExtensions,
        ignoreHidden: prefs.ignoreHiddenFiles,
        skipNonContent: prefs.indexSkipNonContent,
        moveDetectionWindowSeconds: prefs.moveDetectionWindowSeconds,
        missingFileGraceDays: prefs.missingFileGraceDays,
      });
    }
    return configs;
  }

  async updatePreferences (userId: string, patch: Partial<Preferences>): Promise<Preferences> {
    this.cache.delete(userId);
    const raw = await this.repo.updatePreferences(userId, patch as Record<string, unknown>);
    const value = { ...DEFAULT_PREFERENCES, ...normalizePreferenceKeys(raw) };
    this.cache.set(userId, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    return value;
  }
}
