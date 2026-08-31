/**
 * Reads the settings a worker process needs at startup.
 */
import type { PrismaClient } from "@prisma/client";

/**
 * True if the owner has switched low memory mode on.
 *
 * Vault holds one account, so the setting is read from the only user record.
 * A worker reads this once as it starts, which is why the setting takes effect
 * only after the workers are restarted.
 *
 * Returns false if the database cannot be reached, so a worker still starts.
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
