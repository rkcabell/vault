import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireAuth } from "../utils/authGuard.js";
import { PreferencesRepository } from "../repositories/preferencesRepository.js";
import { PreferencesService, type Preferences } from "../services/preferencesService.js";

const preferencesSchema = z
  .object({
    libraryViewMode: z.enum(["grid", "list"]).optional(),
    libraryGridCols: z.union([z.literal(4), z.literal(5), z.literal(6), z.literal(7), z.literal(8)]).optional(),
    libraryIsCompactList: z.boolean().optional(),
    autoTagOnUpload: z.boolean().optional(),
    extractMetadata: z.boolean().optional(),
    detectDuplicates: z.boolean().optional(),
    collapseMetadataByDefault: z.boolean().optional(),
    lowMemoryMode: z.boolean().optional(),
    soonWindowDays: z.number().int().min(2).max(14).optional(),
    themePreference: z.enum(["system", "light", "dark"]).optional(),
    lightTheme: z.string().optional(),
    darkTheme: z.string().optional(),
  })
  .strict();

export const preferencesRoutes: FastifyPluginAsync = async app => {
  const service = new PreferencesService(new PreferencesRepository(app.prisma));

  app.get("/", { preHandler: [requireAuth] }, async (req, reply) => {
    const preferences = await service.getPreferences(req.userId!);
    return reply.send({ preferences });
  });

  app.patch("/", { preHandler: [requireAuth] }, async (req, reply) => {
    const patch: Partial<Preferences> = preferencesSchema.parse(req.body ?? {});
    const preferences = await service.updatePreferences(req.userId!, patch);
    return reply.send({ preferences });
  });
};
