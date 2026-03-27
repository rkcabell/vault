import type { FastifyPluginAsync } from "fastify";
import { requireAuth } from "../utils/authGuard.js";
import { ProfileRepository } from "../repositories/profileRepository.js";
import { ProfileService } from "../services/profileService.js";
import { MediaRepository } from "../repositories/mediaRepository.js";
import { BundleRepository } from "../repositories/bundleRepository.js";
import { SOON_WINDOW_DAYS } from "../lib/reminders/constants.js";
import { buildReminderOverview } from "../lib/reminders/overview.js";

export const initRoutes: FastifyPluginAsync = async app => {
  const profileService = new ProfileService(new ProfileRepository(app.prisma));
  const mediaRepo = new MediaRepository(app.prisma);
  const bundleRepo = new BundleRepository(app.prisma);

  app.get("/", { preHandler: [requireAuth] }, async (_req, reply) => {
    const userId = _req.userId!;
    const now = new Date();
    const preferencesPromise = app.preferencesService.getPreferences(userId);

    const [profile, preferences, rawTags, bundles, totalActive, overviewResult] =
      await Promise.all([
        profileService.getProfile(userId),
        preferencesPromise,
        mediaRepo.listTopTags(userId, 50, 0),
        bundleRepo.listBundles(userId),
        app.prisma.reminder.count({ where: { userId, status: "ACTIVE" } }),
        preferencesPromise.then(prefs =>
          buildReminderOverview(
            userId,
            app.prisma,
            (prefs.soonWindowDays as number | undefined) ?? SOON_WINDOW_DAYS,
            now,
          )
        ),
      ]);

    return reply.send({
      user: profile
        ? {
            id: profile.id,
            email: profile.email,
            name: profile.name,
            username: profile.username,
            avatarUrl: profile.avatarUrl,
          }
        : null,
      preferences,
      tags: rawTags.tags.map(t => ({ name: t.tag, count: t.count, color: t.color })),
      bundles,
      remindersSummary: { ...overviewResult.counts, totalActive, soonWindowDays: (preferences.soonWindowDays as number | undefined) ?? SOON_WINDOW_DAYS },
      overviewReminders: { items: overviewResult.items },
    });
  });
};
