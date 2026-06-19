import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireAuth } from "../utils/authGuard.js";
import type { Preferences } from "@vault/types";

const preferencesSchema = z
  .object({
    libraryViewMode: z.enum(["grid", "list"]).optional(),
    libraryGridCols: z.union([z.literal(4), z.literal(5), z.literal(6), z.literal(7), z.literal(8)]).optional(),
    libraryIsCompactList: z.boolean().optional(),
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
  })
  .strict();

export const preferencesRoutes: FastifyPluginAsync = async app => {
  app.get("/", { preHandler: [requireAuth] }, async (req, reply) => {
    const preferences = await app.preferencesService.getPreferences(req.userId!);
    return reply.send({ preferences });
  });

  app.patch("/", { preHandler: [requireAuth] }, async (req, reply) => {
    const patch: Partial<Preferences> = preferencesSchema.parse(req.body ?? {});
    const preferences = await app.preferencesService.updatePreferences(req.userId!, patch);
    return reply.send({ preferences });
  });
};
