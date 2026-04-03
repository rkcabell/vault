import type { PreferencesRepository } from "../repositories/preferencesRepository.js";
import { type Preferences, DEFAULT_PREFERENCES } from "@vault/types";

const CACHE_TTL_MS = 60_000;

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

  async updatePreferences (userId: string, patch: Partial<Preferences>): Promise<Preferences> {
    this.cache.delete(userId);
    const raw = await this.repo.updatePreferences(userId, patch as Record<string, unknown>);
    const value = { ...DEFAULT_PREFERENCES, ...(raw as Partial<Preferences> ?? {}) };
    this.cache.set(userId, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    return value;
  }
}
