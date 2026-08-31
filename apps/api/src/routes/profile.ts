/**
 * Serves the account details a user sees and edits on their profile page.
 */
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireAuth } from "../utils/authGuard.js";
import { ProfileRepository } from "../repositories/profileRepository.js";
import { ProfileService } from "../services/profileService.js";

// Every field is optional and may be set to null, so a request updates only
// what it names. An unrecognized field is rejected rather than ignored.
const profileSchema = z
  .object({
    name: z.string().trim().max(200).optional().nullable(),
    username: z.string().trim().max(80).optional().nullable(),
    bio: z.string().trim().max(1000).optional().nullable(),
    website: z.string().trim().max(200).optional().nullable(),
    location: z.string().trim().max(200).optional().nullable(),
    avatarUrl: z.string().trim().max(400).optional().nullable(),
  })
  .strict();

export const profileRoutes: FastifyPluginAsync = async app => {
  const profileService = new ProfileService(new ProfileRepository(app.prisma));

  app.get("/", { preHandler: [requireAuth] }, async (req, reply) => {
    const userId = req.userId!;
    const profile = await profileService.getProfile(userId);

    if (!profile) return reply.notFound();
    return reply.send({ profile });
  });

  app.patch("/", { preHandler: [requireAuth] }, async (req, reply) => {
    const userId = req.userId!;
    const parsed = profileSchema.parse(req.body ?? {});

    const profile = await profileService.updateProfile(userId, parsed);

    if (!profile) return reply.notFound();

    return reply.send({ profile });
  });
};
