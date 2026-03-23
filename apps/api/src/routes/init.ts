import type { FastifyPluginAsync } from "fastify";
import { requireAuth } from "../utils/authGuard.js";
import { ProfileRepository } from "../repositories/profileRepository.js";
import { ProfileService } from "../services/profileService.js";
import { PreferencesRepository } from "../repositories/preferencesRepository.js";
import { PreferencesService } from "../services/preferencesService.js";
import { MediaRepository } from "../repositories/mediaRepository.js";
import { BundleRepository } from "../repositories/bundleRepository.js";
import { SOON_WINDOW_DAYS } from "../lib/reminders/constants.js";
import { REMINDER_BUCKET_ORDER, getEffectiveDueAt, getReminderBucket } from "../lib/reminders/time.js";

const OVERVIEW_LIMIT = 5;
const OVERVIEW_PREFETCH = OVERVIEW_LIMIT * 20;

const overviewSelect = {
  id: true,
  title: true,
  note: true,
  dueAt: true,
  nextDueAt: true,
  remindAt: true,
  snoozedUntil: true,
  timezone: true,
  remindOffsetDays: true,
  media: { select: { id: true, title: true } },
} as const;

export const initRoutes: FastifyPluginAsync = async app => {
  const profileService = new ProfileService(new ProfileRepository(app.prisma));
  const prefsService = new PreferencesService(new PreferencesRepository(app.prisma));
  const mediaRepo = new MediaRepository(app.prisma);
  const bundleRepo = new BundleRepository(app.prisma);

  app.get("/", { preHandler: [requireAuth] }, async (_req, reply) => {
    const userId = _req.userId!;
    const now = new Date();
    const preferencesPromise = prefsService.getPreferences(userId);

    const [profile, preferences, rawTags, bundles, totalActive, overviewResult] =
      await Promise.all([
        profileService.getProfile(userId),
        preferencesPromise,
        mediaRepo.listTopTags(userId, 50, 0),
        bundleRepo.listBundles(userId),
        app.prisma.reminder.count({ where: { userId, status: "ACTIVE" } }),
        (async () => {
          const visible = await app.prisma.reminder.findMany({
            where: {
              userId,
              status: "ACTIVE",
              remindAt: { lte: now },
              OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: now } }],
            },
            take: OVERVIEW_PREFETCH,
            select: overviewSelect,
          });

          const loadedPreferences = await preferencesPromise;
          const soonWindowDays = loadedPreferences.soonWindowDays ?? SOON_WINDOW_DAYS;

          type OverviewDbRow = typeof visible[number];
          const toRow = (r: OverviewDbRow) => {
            const effectiveDueAt = getEffectiveDueAt(r.dueAt, r.nextDueAt);
            const bucket = getReminderBucket(effectiveDueAt, r.timezone, now, soonWindowDays);
            return {
              id: r.id,
              title: r.title,
              note: r.note,
              media: r.media,
              effectiveDueAt: effectiveDueAt.toISOString(),
              remindAt: r.remindAt.toISOString(),
              snoozedUntil: r.snoozedUntil ? r.snoozedUntil.toISOString() : null,
              bucket,
              isOverdue: bucket === "overdue",
              remindOffsetDays: r.remindOffsetDays,
            };
          };

          type OverviewRow = ReturnType<typeof toRow>;
          const sortRows = (rows: OverviewRow[]) => {
            const nowMs = now.getTime();
            rows.sort((a, b) => {
              const aSnoozed = a.snoozedUntil !== null && new Date(a.snoozedUntil).getTime() > nowMs;
              const bSnoozed = b.snoozedUntil !== null && new Date(b.snoozedUntil).getTime() > nowMs;
              if (aSnoozed !== bSnoozed) return aSnoozed ? 1 : -1;
              const bucketSort = REMINDER_BUCKET_ORDER[a.bucket] - REMINDER_BUCKET_ORDER[b.bucket];
              if (bucketSort !== 0) return bucketSort;
              return new Date(a.effectiveDueAt).getTime() - new Date(b.effectiveDueAt).getTime();
            });
          };

          const visibleRows = visible.map(toRow);
          sortRows(visibleRows);

          // Compute summary bucket counts from the full visible rows.
          const counts = { visibleNow: visibleRows.length, overdue: 0, dueToday: 0, dueSoon: 0 };
          for (const row of visibleRows) {
            if (row.bucket === "overdue") counts.overdue += 1;
            else if (row.bucket === "today") counts.dueToday += 1;
            else if (row.bucket === "soon") counts.dueSoon += 1;
          }

          let overviewItems = visibleRows.slice(0, OVERVIEW_LIMIT);

          // Backfill with hidden reminders if visible count is below limit.
          if (visibleRows.length < OVERVIEW_LIMIT) {
            const remaining = OVERVIEW_LIMIT - visibleRows.length;
            const hidden = await app.prisma.reminder.findMany({
              where: {
                userId,
                status: "ACTIVE",
                OR: [{ remindAt: { gt: now } }, { snoozedUntil: { gt: now } }],
              },
              take: OVERVIEW_PREFETCH,
              select: overviewSelect,
            });
            const hiddenRows = hidden.map(toRow);
            sortRows(hiddenRows);
            overviewItems = [...visibleRows, ...hiddenRows.slice(0, remaining)];
          }

          return { items: overviewItems, counts };
        })(),
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
