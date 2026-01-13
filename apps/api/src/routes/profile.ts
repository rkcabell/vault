// File: apps/api/src/routes/profile.ts
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireAuth } from "../utils/authGuard.js";

const profileSelect = {
  id: true,
  email: true,
  name: true,
  username: true,
  bio: true,
  website: true,
  location: true,
  avatarUrl: true,
  createdAt: true,
};

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

function normalize(value: string | null | undefined) {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

export const profileRoutes: FastifyPluginAsync = async app => {
  app.get("/", { preHandler: [requireAuth] }, async (req, reply) => {
    const userId = req.userId!;
    const profile = await app.prisma.user.findUnique({
      where: { id: userId },
      select: profileSelect,
    });

    if (!profile) return reply.notFound();
    return reply.send({ profile });
  });

  app.patch("/", { preHandler: [requireAuth] }, async (req, reply) => {
    const userId = req.userId!;
    const parsed = profileSchema.parse(req.body ?? {});

    const data: {
      name?: string | null;
      username?: string | null;
      bio?: string | null;
      website?: string | null;
      location?: string | null;
      avatarUrl?: string | null;
    } = {};

    if (Object.prototype.hasOwnProperty.call(parsed, "name")) {
      data.name = normalize(parsed.name);
    }
    if (Object.prototype.hasOwnProperty.call(parsed, "username")) {
      data.username = normalize(parsed.username);
    }
    if (Object.prototype.hasOwnProperty.call(parsed, "bio")) {
      data.bio = normalize(parsed.bio);
    }
    if (Object.prototype.hasOwnProperty.call(parsed, "website")) {
      data.website = normalize(parsed.website);
    }
    if (Object.prototype.hasOwnProperty.call(parsed, "location")) {
      data.location = normalize(parsed.location);
    }
    if (Object.prototype.hasOwnProperty.call(parsed, "avatarUrl")) {
      data.avatarUrl = normalize(parsed.avatarUrl);
    }

    if (Object.keys(data).length === 0) {
      const profile = await app.prisma.user.findUnique({
        where: { id: userId },
        select: profileSelect,
      });
      if (!profile) return reply.notFound();
      return reply.send({ profile });
    }

    const profile = await app.prisma.user.update({
      where: { id: userId },
      data,
      select: profileSelect,
    });

    return reply.send({ profile });
  });
};
