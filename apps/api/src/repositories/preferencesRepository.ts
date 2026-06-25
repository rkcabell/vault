import type { Prisma, PrismaClient } from "@prisma/client";

export class PreferencesRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async getPreferences (userId: string) {
    const row = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { preferences: true },
    });
    return row?.preferences ?? null;
  }

  /** Raw preferences for every user — used by the index watcher to discover
   *  which roots to watch across all accounts (single-user in practice). */
  async listAll () {
    return this.prisma.user.findMany({ select: { id: true, preferences: true } });
  }

  async updatePreferences (userId: string, patch: Record<string, unknown>) {
    const row = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { preferences: true },
    });

    const rawExisting = row?.preferences;
    const existing: Prisma.InputJsonObject =
      rawExisting && typeof rawExisting === "object" && !Array.isArray(rawExisting)
        ? (rawExisting as Prisma.InputJsonObject)
        : {};
    const merged: Prisma.InputJsonObject = { ...existing, ...(patch as Prisma.InputJsonObject) };

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { preferences: merged },
      select: { preferences: true },
    });

    return updated.preferences;
  }
}
