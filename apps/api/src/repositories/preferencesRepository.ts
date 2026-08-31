import type { Prisma, PrismaClient } from "@prisma/client";
import { normalizePreferenceKeys } from "@vault/types";

/**
 * Reads and writes the preferences JSON stored on each user row.
 */

export class PreferencesRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async getPreferences (userId: string) {
    const row = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { preferences: true },
    });
    return row?.preferences ?? null;
  }

  /** Returns every user's raw preferences. The index watcher reads this to
   *  find the roots to watch across all accounts. */
  async listAll () {
    return this.prisma.user.findMany({ select: { id: true, preferences: true } });
  }

  async updatePreferences (userId: string, patch: Record<string, unknown>) {
    const row = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { preferences: true },
    });

    // Normalizing on the way in means a write also retires legacy key names,
    // rather than merging on top of them.
    const existing = normalizePreferenceKeys(row?.preferences) as Prisma.InputJsonObject;
    const merged: Prisma.InputJsonObject = { ...existing, ...(patch as Prisma.InputJsonObject) };

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { preferences: merged },
      select: { preferences: true },
    });

    return updated.preferences;
  }
}
