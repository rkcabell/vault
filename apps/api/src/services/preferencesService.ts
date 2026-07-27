import type { PreferencesRepository } from "../repositories/preferencesRepository.js";
import { type Preferences, DEFAULT_PREFERENCES } from "@vault/types";

const CACHE_TTL_MS = 60_000;

/** The subset of a user's preferences the index watcher needs to watch + filter. */
export interface IndexConfig {
  userId: string;
  allowedRoots: string[];
  excludeFolders: string[];
  blacklistExtensions: string[];
  ignoreHidden: boolean;
  skipNonContent: boolean;
  /** Seconds a vanished file stays rematchable as a move. See Preferences. */
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
    const value = { ...DEFAULT_PREFERENCES, ...(raw as Partial<Preferences> ?? {}) };
    this.cache.set(userId, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    return value;
  }

  /**
   * The in-place indexing config for every user that has at least one allowed
   * root. The live watcher polls this to know which directories to watch and how
   * to filter them. Bypasses the per-user cache — it reads all users at once.
   */
  async listIndexConfigs (): Promise<IndexConfig[]> {
    const rows = await this.repo.listAll();
    const configs: IndexConfig[] = [];
    for (const row of rows) {
      const prefs = { ...DEFAULT_PREFERENCES, ...((row.preferences as Partial<Preferences>) ?? {}) };
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
    const value = { ...DEFAULT_PREFERENCES, ...(raw as Partial<Preferences> ?? {}) };
    this.cache.set(userId, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    return value;
  }
}
