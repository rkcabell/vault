import type { PreferencesRepository } from "../repositories/preferencesRepository.js";

export type Preferences = {
  libraryViewMode: "grid" | "list";
  libraryGridCols: 4 | 5 | 6 | 7 | 8;
  libraryIsCompactList: boolean;
  autoTagOnUpload: boolean;
  extractMetadata: boolean;
  detectDuplicates: boolean;
  collapseMetadataByDefault: boolean;
  lowMemoryMode: boolean;
  soonWindowDays: number;
  themePreference: "system" | "light" | "dark";
  lightTheme: string;
  darkTheme: string;
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
  soonWindowDays: 7,
  themePreference: "system",
  lightTheme: "default",
  darkTheme: "new-moon",
};

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
