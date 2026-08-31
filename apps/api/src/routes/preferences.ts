import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireAuth } from "../utils/authGuard.js";
import { normalizePreferenceKeys, type Preferences } from "@vault/types";

/**
 * Reads and updates a user's preferences. The schema below is the set the server
 * accepts; an unknown key is rejected rather than stored.
 */

const preferencesSchema = z
  .object({
    libraryViewMode: z.enum(["grid", "list"]).optional(),
    libraryGridCols: z.union([z.literal(4), z.literal(5), z.literal(6), z.literal(7), z.literal(8)]).optional(),
    libraryIsCompactList: z.boolean().optional(),
    autoTagOnIngest: z.boolean().optional(),
    // The former name for autoTagOnIngest. Still accepted because the schema is
    // strict, and a tab running older JS would otherwise 400 on every save.
    autoTagOnUpload: z.boolean().optional(),
    extractMetadata: z.boolean().optional(),
    detectDuplicates: z.boolean().optional(),
    lowMemoryMode: z.boolean().optional(),
    autoUnpackArchives: z.boolean().optional(),
    hideUnpackedItems: z.boolean().optional(),
    ignoreHiddenFiles: z.boolean().optional(),
    soonWindowDays: z.number().int().min(2).max(14).optional(),
    themePreference: z.enum(["system", "light", "dark"]).optional(),
    yellowHighlight: z.boolean().optional(),
    lightTheme: z.enum(["default", "latte", "sandstone", "mist", "lavender", "dream", "cotton-candy", "mint", "garden"]).optional(),
    darkTheme: z.enum(["new-moon", "matrix", "charcoal", "solarized"]).optional(),
    exploreBucketColors: z.record(z.string().regex(/^#[0-9a-fA-F]{6}$/)).optional(),
    // The lower bound keeps a directory move's burst of events inside one
    // window. The upper bound keeps the set of candidates small enough to scan.
    moveDetectionWindowSeconds: z.number().int().min(30).max(3600).optional(),
    // At least a day: anything shorter can sweep away an unmounted drive's
    // items before the user notices they are gone.
    missingFileGraceDays: z.number().int().min(1).max(365).optional(),
    // Governs tier-2 OCR only. Native text extraction runs at index time either
    // way.
    ocrMode: z.enum(["onDemand", "background", "off"]).optional(),
    // Under a minute, startup overhead alone outlasts the cap and no job ever
    // finishes. Over an hour, one stuck scan holds a worker slot too long.
    ocrTimeoutCapMinutes: z.number().int().min(1).max(60).optional(),
    // There is no "inline" mode: nothing is ever written beside a source file.
    sidecarMode: z.enum(["off", "snapshot"]).optional(),
    sidecarIntervalMinutes: z.union([
      z.literal(5), z.literal(15), z.literal(60), z.literal(360), z.literal(1440),
    ]).optional(),
  })
  .strict();

export const preferencesRoutes: FastifyPluginAsync = async app => {
  app.get("/", { preHandler: [requireAuth] }, async (req, reply) => {
    const preferences = await app.preferencesService.getPreferences(req.userId!);
    return reply.send({ preferences });
  });

  app.patch("/", { preHandler: [requireAuth] }, async (req, reply) => {
    const patch: Partial<Preferences> = normalizePreferenceKeys(preferencesSchema.parse(req.body ?? {}));
    const preferences = await app.preferencesService.updatePreferences(req.userId!, patch);
    return reply.send({ preferences });
  });
};
