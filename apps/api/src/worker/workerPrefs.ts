import type { PrismaClient } from "@prisma/client";

/**
 * Reads the `lowMemoryMode` preference from the first user record in the DB.
 * Used by worker entry points on startup so the setting toggled in the web UI
 * takes effect after the workers restart (Docker restarts them automatically
 * via `restart: on-failure`).
 *
 * Returns false on any error so workers start normally if the DB is unreachable.
 */
export async function readLowMemoryPreference(prisma: PrismaClient): Promise<boolean> {
  try {
    const user = await prisma.user.findFirst({ select: { preferences: true } });
    const prefs = user?.preferences as Record<string, unknown> | null;
    return prefs?.lowMemoryMode === true;
  } catch {
    return false;
  }
}
