import type { PreferencesRepository } from "../repositories/preferencesRepository.js";
import { type Preferences, DEFAULT_PREFERENCES } from "@vault/types";

export class PreferencesService {
  constructor(private readonly repo: PreferencesRepository) {}

  async getPreferences (userId: string): Promise<Preferences> {
    const raw = await this.repo.getPreferences(userId);
    return { ...DEFAULT_PREFERENCES, ...(raw as Partial<Preferences> ?? {}) };
  }

  async updatePreferences (userId: string, patch: Partial<Preferences>): Promise<Preferences> {
    const raw = await this.repo.updatePreferences(userId, patch as Record<string, unknown>);
    return { ...DEFAULT_PREFERENCES, ...(raw as Partial<Preferences> ?? {}) };
  }
}
