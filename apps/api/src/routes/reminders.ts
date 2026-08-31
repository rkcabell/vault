/**
 * Serves the reminders screen: listing what is due, and creating, editing,
 * completing, snoozing and cancelling a reminder.
 */
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireAuth } from "../utils/authGuard.js";
import { SOON_WINDOW_DAYS } from "../lib/reminders/constants.js";
import {
  REMINDER_BUCKET_ORDER,
  computeRemindAt,
  getEffectiveDueAt,
  getReminderBucket,
  normalizeTimezone,
  type ReminderBucket,
} from "../lib/reminders/time.js";
import { ReminderRRuleError, advanceRecurringDue, isRecurrenceExpired, validateRRule } from "../lib/reminders/recurrence.js";

type ReminderStatusDb = "ACTIVE" | "COMPLETED" | "CANCELED";
type ReminderStatusApi = "active" | "completed" | "canceled";

/** One reminder as the reminders screen renders it, with dates already turned into strings. */
type ReminderOverviewRow = {
  id: string;
  title: string;
  note: string | null;
  media: { id: string; title: string } | null;
  effectiveDueAt: string;
  remindAt: string;
  snoozedUntil: string | null;
  bucket: ReminderBucket;
  isOverdue: boolean;
  remindOffsetDays: number | null;
  rrule: string | null;
};

/** One finished reminder, shown in the completed list. */
type ReminderCompletedRow = {
  id: string;
  title: string;
  note: string | null;
  media: { id: string; title: string } | null;
  lastCompletedAt: string;
  dueAt: string;
};

/** A whole reminder as returned after it is created or changed. */
type ReminderOutput = {
  id: string;
  userId: string;
  title: string;
  note: string | null;
  mediaId: string | null;
  status: ReminderStatusApi;
  timezone: string;
  dueAt: string;
  nextDueAt: string | null;
  remindOffsetDays: number | null;
  remindAt: string;
  snoozedUntil: string | null;
  rrule: string | null;
  lastCompletedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

const paramsSchema = z.object({ id: z.string().uuid() }).strict();
// Accepts both a date string and a timestamp, and refuses anything that does
// not read as a real moment.
const dateSchema = z.coerce.date().refine(value => !Number.isNaN(value.getTime()), "Invalid datetime");

const createReminderSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    note: z.string().trim().max(5000).nullable().optional(),
    mediaId: z.string().uuid().nullable().optional(),
    dueAt: dateSchema,
    remindOffsetDays: z.number().int().min(0).max(3650).nullable().optional(),
    rrule: z.string().trim().min(1).max(1000).nullable().optional(),
  })
  .strict();

const updateReminderSchema = z
  .object({
    title: z.string().trim().min(1).max(300).optional(),
    note: z.string().trim().max(5000).nullable().optional(),
    mediaId: z.string().uuid().nullable().optional(),
    dueAt: dateSchema.optional(),
    remindOffsetDays: z.number().int().min(0).max(3650).nullable().optional(),
    rrule: z.string().trim().min(1).max(1000).nullable().optional(),
  })
  .strict()
  .refine(
    payload =>
      payload.title !== undefined ||
      payload.note !== undefined ||
      payload.mediaId !== undefined ||
      payload.dueAt !== undefined ||
      payload.remindOffsetDays !== undefined ||
      payload.rrule !== undefined,
    { message: "Provide at least one field to update" },
  );

// The stored status names are upper case; the screen uses lower case.
function toStatusApi(status: ReminderStatusDb): ReminderStatusApi {
  if (status === "ACTIVE") return "active";
  if (status === "COMPLETED") return "completed";
  return "canceled";
}

// Returns the recurrence rule with surrounding space removed, treating an empty
// string as no rule at all.
function normalizeRRuleInput(rrule: string | null | undefined) {
  const nextValue = rrule?.trim() ?? null;
  return nextValue && nextValue.length > 0 ? nextValue : null;
}

// Builds one row of the reminders screen, working out which group it belongs
// to and turning its dates into strings.
function toOverviewRow(
  reminder: {
    id: string;
    title: string;
    note: string | null;
    dueAt: Date;
    nextDueAt: Date | null;
    remindAt: Date;
    snoozedUntil: Date | null;
    timezone: string;
    remindOffsetDays: number | null;
    rrule: string | null;
    media: { id: string; title: string } | null;
  },
  now: Date,
  soonWindowDays?: number,
) {
  const effectiveDueAt = getEffectiveDueAt(reminder.dueAt, reminder.nextDueAt);
  const bucket = getReminderBucket(effectiveDueAt, reminder.timezone, now, soonWindowDays);

  return {
    id: reminder.id,
    title: reminder.title,
    note: reminder.note,
    media: reminder.media,
    effectiveDueAt: effectiveDueAt.toISOString(),
    remindAt: reminder.remindAt.toISOString(),
    snoozedUntil: reminder.snoozedUntil ? reminder.snoozedUntil.toISOString() : null,
    bucket,
    isOverdue: bucket === "overdue",
    remindOffsetDays: reminder.remindOffsetDays,
    rrule: reminder.rrule,
  } satisfies ReminderOverviewRow;
}

// Orders rows the way the screen shows them: snoozed reminders last, then by
// group, then by the date each is due.
function sortOverviewRows(rows: ReminderOverviewRow[]) {
  const nowMs = Date.now();

  rows.sort((left, right) => {
    const leftSnoozed = left.snoozedUntil !== null && new Date(left.snoozedUntil).getTime() > nowMs;
    const rightSnoozed = right.snoozedUntil !== null && new Date(right.snoozedUntil).getTime() > nowMs;
    if (leftSnoozed !== rightSnoozed) return leftSnoozed ? 1 : -1;

    const bucketSort = REMINDER_BUCKET_ORDER[left.bucket] - REMINDER_BUCKET_ORDER[right.bucket];
    if (bucketSort !== 0) return bucketSort;
    return new Date(left.effectiveDueAt).getTime() - new Date(right.effectiveDueAt).getTime();
  });
}

function toReminderOutput(reminder: {
  id: string;
  userId: string;
  title: string;
  note: string | null;
  mediaId: string | null;
  status: ReminderStatusDb;
  timezone: string;
  dueAt: Date;
  nextDueAt: Date | null;
  remindOffsetDays: number | null;
  remindAt: Date;
  snoozedUntil: Date | null;
  rrule: string | null;
  lastCompletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: reminder.id,
    userId: reminder.userId,
    title: reminder.title,
    note: reminder.note,
    mediaId: reminder.mediaId,
    status: toStatusApi(reminder.status),
    timezone: reminder.timezone,
    dueAt: reminder.dueAt.toISOString(),
    nextDueAt: reminder.nextDueAt ? reminder.nextDueAt.toISOString() : null,
    remindOffsetDays: reminder.remindOffsetDays,
    remindAt: reminder.remindAt.toISOString(),
    snoozedUntil: reminder.snoozedUntil ? reminder.snoozedUntil.toISOString() : null,
    rrule: reminder.rrule,
    lastCompletedAt: reminder.lastCompletedAt ? reminder.lastCompletedAt.toISOString() : null,
    createdAt: reminder.createdAt.toISOString(),
    updatedAt: reminder.updatedAt.toISOString(),
  } satisfies ReminderOutput;
}

function toCompletedRow(reminder: {
  id: string;
  title: string;
  note: string | null;
  dueAt: Date;
  lastCompletedAt: Date | null;
  updatedAt: Date;
  media: { id: string; title: string } | null;
}) {
  return {
    id: reminder.id,
    title: reminder.title,
    note: reminder.note,
    media: reminder.media,
    lastCompletedAt: (reminder.lastCompletedAt ?? reminder.updatedAt).toISOString(),
    dueAt: reminder.dueAt.toISOString(),
  } satisfies ReminderCompletedRow;
}

// Refuses a reminder attached to a media item the user does not own. Does
// nothing when the reminder is attached to no item.
async function assertMediaOwnership(
  app: {
    prisma: {
      media: {
        findFirst: (args: {
          where: { id: string; userId: string };
          select: { id: true };
        }) => Promise<{ id: string } | null>;
      };
    };
    httpErrors: { badRequest: (message: string) => Error };
  },
  userId: string,
  mediaId: string | null,
) {
  if (!mediaId) return;
  const media = await app.prisma.media.findFirst({
    where: { id: mediaId, userId },
    select: { id: true },
  });
  if (!media) throw app.httpErrors.badRequest("mediaId does not belong to the authenticated user");
}

export const remindersRoutes: FastifyPluginAsync = async app => {
  // The figures shown on the reminders button: how many are waiting now, and
  // how many of those are overdue, due today or due soon.
  app.get("/summary", { preHandler: [requireAuth] }, async req => {
    const userId = req.userId!;
    const now = new Date();

    const [totalActive, visibleReminders] = await Promise.all([
      app.prisma.reminder.count({
        where: { userId, status: "ACTIVE" },
      }),
      app.prisma.reminder.findMany({
        where: {
          userId,
          status: "ACTIVE",
          remindAt: { lte: now },
          OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: now } }],
        },
        select: {
          dueAt: true,
          nextDueAt: true,
          timezone: true,
        },
      }),
    ]);

    const counts = {
      visibleNow: visibleReminders.length,
      overdue: 0,
      dueToday: 0,
      dueSoon: 0,
    };

    for (const reminder of visibleReminders) {
      const effectiveDueAt = getEffectiveDueAt(reminder.dueAt, reminder.nextDueAt);
      const bucket = getReminderBucket(effectiveDueAt, reminder.timezone, now);
      if (bucket === "overdue") counts.overdue += 1;
      else if (bucket === "today") counts.dueToday += 1;
      else if (bucket === "soon") counts.dueSoon += 1;
    }

    return {
      ...counts,
      totalActive,
      soonWindowDays: SOON_WINDOW_DAYS,
    };
  });

  // The reminders list. `view=all` returns every active reminder; `view=overview`
  // returns only those that are due to be shown now, padded out with ones that
  // are not yet due when too few are showing.
  app.get("/", { preHandler: [requireAuth] }, async req => {
    const userId = req.userId!;
    const query = z
      .object({
        status: z.enum(["active", "completed", "canceled"]).default("active"),
        view: z.enum(["overview", "all"]).default("overview"),
        limit: z.coerce.number().int().min(1).max(100).default(5),
        soonWindowDays: z.coerce.number().int().min(2).max(14).default(7),
      })
      .parse(req.query);

    if (query.status === "canceled") {
      throw app.httpErrors.badRequest("status=canceled is not supported");
    }

    if (query.status === "completed") {
      if (query.view !== "all") {
        throw app.httpErrors.badRequest("Only view=all is supported for status=completed");
      }

      const completedReminders = await app.prisma.reminder.findMany({
        where: { userId, status: "COMPLETED" },
        take: query.limit,
        orderBy: [{ lastCompletedAt: "desc" }, { updatedAt: "desc" }],
        select: {
          id: true,
          title: true,
          note: true,
          dueAt: true,
          lastCompletedAt: true,
          updatedAt: true,
          media: {
            select: {
              id: true,
              title: true,
            },
          },
        },
      });

      return { items: completedReminders.map(toCompletedRow) };
    }

    const now = new Date();

    const reminderSelect = {
      id: true,
      title: true,
      note: true,
      dueAt: true,
      nextDueAt: true,
      remindAt: true,
      snoozedUntil: true,
      timezone: true,
      remindOffsetDays: true,
      rrule: true,
      media: {
        select: {
          id: true,
          title: true,
        },
      },
    } as const;

    if (query.view === "all") {
      // Every active reminder, including those that are not yet due to be shown.
      const allReminders = await app.prisma.reminder.findMany({
        where: { userId, status: "ACTIVE" },
        take: query.limit,
        orderBy: { dueAt: "asc" },
        select: reminderSelect,
      });
      const rows = allReminders.map(reminder => toOverviewRow(reminder, now, query.soonWindowDays));
      sortOverviewRows(rows);
      return { items: rows };
    }

    // Grouping and ordering happen here rather than in the query, because the
    // group a reminder falls in depends on its own timezone. More rows are read
    // than are returned, up to a fixed ceiling.
    const prefetch = Math.min(query.limit * 20, 500);

    // The reminders that are due to be shown now.
    const visibleReminders = await app.prisma.reminder.findMany({
      where: {
        userId,
        status: "ACTIVE",
        remindAt: { lte: now },
        OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: now } }],
      },
      take: prefetch,
      select: reminderSelect,
    });

    const visibleRows = visibleReminders.map(reminder => toOverviewRow(reminder, now, query.soonWindowDays));
    sortOverviewRows(visibleRows);

    if (visibleRows.length >= query.limit) {
      return { items: visibleRows.slice(0, query.limit) };
    }

    // Too few to fill the screen, so it is padded out with reminders that are
    // snoozed or not yet due.
    const remaining = query.limit - visibleRows.length;

    const hiddenReminders = await app.prisma.reminder.findMany({
      where: {
        userId,
        status: "ACTIVE",
        OR: [{ remindAt: { gt: now } }, { snoozedUntil: { gt: now } }],
      },
      take: prefetch,
      select: reminderSelect,
    });

    const fallbackRows = hiddenReminders.map(reminder => toOverviewRow(reminder, now, query.soonWindowDays));
    sortOverviewRows(fallbackRows);

    return { items: [...visibleRows, ...fallbackRows.slice(0, remaining)] };
  });

  // Creates a reminder. The browser sends its timezone in an `x-timezone`
  // header, which decides what "today" means for this reminder from then on.
  app.post("/", { preHandler: [requireAuth] }, async (req, reply) => {
    const userId = req.userId!;
    const body = createReminderSchema.parse(req.body ?? {});
    const now = new Date();

    if (body.dueAt.getTime() <= now.getTime()) {
      throw app.httpErrors.badRequest("Due datetime must be in the future");
    }

    const rrule = normalizeRRuleInput(body.rrule);
    if (rrule) {
      try {
        validateRRule(rrule);
      } catch (error) {
        if (error instanceof ReminderRRuleError) throw app.httpErrors.badRequest(error.message);
        throw error;
      }
    }

    const timezoneHeader = req.headers["x-timezone"];
    const timezoneValue = Array.isArray(timezoneHeader) ? timezoneHeader[0] : timezoneHeader;
    const timezone = normalizeTimezone(timezoneValue);

    await assertMediaOwnership(app, userId, body.mediaId ?? null);

    const dueAt = body.dueAt;
    const nextDueAt = rrule ? dueAt : null;
    const remindOffsetDays = body.remindOffsetDays ?? null;
    const remindAt = computeRemindAt(dueAt, nextDueAt, remindOffsetDays);

    const reminder = await app.prisma.reminder.create({
      data: {
        userId,
        title: body.title,
        note: body.note ?? null,
        mediaId: body.mediaId ?? null,
        status: "ACTIVE",
        timezone,
        dueAt,
        remindOffsetDays,
        remindAt,
        rrule,
        nextDueAt,
      },
    });

    return reply.code(201).send({ reminder: toReminderOutput(reminder) });
  });

  // Changes a reminder. Editing anything that affects its timing works out a new
  // date for it to start showing.
  app.patch<{ Params: { id: string } }>("/:id", { preHandler: [requireAuth] }, async (req, reply) => {
    const userId = req.userId!;
    const { id } = paramsSchema.parse(req.params);
    const rawBody = (req.body ?? {}) as Record<string, unknown>;
    const body = updateReminderSchema.parse(rawBody);

    const reminder = await app.prisma.reminder.findFirst({
      where: { id, userId },
      select: {
        id: true,
        dueAt: true,
        nextDueAt: true,
        remindAt: true,
        remindOffsetDays: true,
        rrule: true,
      },
    });

    if (!reminder) return reply.notFound();

    const hasDueAt = Object.prototype.hasOwnProperty.call(rawBody, "dueAt");
    const hasRemindOffsetDays = Object.prototype.hasOwnProperty.call(rawBody, "remindOffsetDays");
    const hasRRule = Object.prototype.hasOwnProperty.call(rawBody, "rrule");
    const hasMediaId = Object.prototype.hasOwnProperty.call(rawBody, "mediaId");
    const hasNote = Object.prototype.hasOwnProperty.call(rawBody, "note");
    const hasTitle = Object.prototype.hasOwnProperty.call(rawBody, "title");

    const nextDueAtBase = hasDueAt ? body.dueAt! : reminder.dueAt;
    const nextRemindOffsetDays = hasRemindOffsetDays
      ? (body.remindOffsetDays ?? null)
      : reminder.remindOffsetDays;
    const nextRRule = hasRRule ? normalizeRRuleInput(body.rrule) : reminder.rrule;

    if (nextRRule) {
      try {
        validateRRule(nextRRule);
      } catch (error) {
        if (error instanceof ReminderRRuleError) throw app.httpErrors.badRequest(error.message);
        throw error;
      }
    }

    let nextDueAt: Date | null = reminder.nextDueAt;
    if (!nextRRule) {
      nextDueAt = null;
    } else if (hasDueAt || hasRRule || !nextDueAt) {
      nextDueAt = nextDueAtBase;
    }

    if (hasMediaId) {
      await assertMediaOwnership(app, userId, body.mediaId ?? null);
    }

    const timingChanged = hasDueAt || hasRemindOffsetDays || hasRRule;
    const nextRemindAt = timingChanged
      ? computeRemindAt(nextDueAtBase, nextDueAt, nextRemindOffsetDays)
      : reminder.remindAt;

    const updated = await app.prisma.reminder.update({
      where: { id },
      data: {
        ...(hasTitle ? { title: body.title } : {}),
        ...(hasNote ? { note: body.note ?? null } : {}),
        ...(hasMediaId ? { mediaId: body.mediaId ?? null } : {}),
        ...(hasDueAt ? { dueAt: nextDueAtBase } : {}),
        ...(hasRemindOffsetDays ? { remindOffsetDays: nextRemindOffsetDays } : {}),
        ...(hasRRule ? { rrule: nextRRule } : {}),
        ...(timingChanged ? { nextDueAt } : {}),
        ...(timingChanged ? { remindAt: nextRemindAt } : {}),
      },
    });

    return reply.send({ reminder: toReminderOutput(updated) });
  });

  // Marks a reminder done. One that repeats moves on to its next date and stays
  // active, unless the recurrence has reached its end.
  app.post<{ Params: { id: string } }>(
    "/:id/complete",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const userId = req.userId!;
      const { id } = paramsSchema.parse(req.params);
      const now = new Date();

      const reminder = await app.prisma.reminder.findFirst({
        where: { id, userId },
        select: {
          id: true,
          status: true,
          dueAt: true,
          nextDueAt: true,
          remindOffsetDays: true,
          rrule: true,
        },
      });

      if (!reminder) return reply.notFound();
      if (reminder.status !== "ACTIVE") {
        throw app.httpErrors.badRequest("Only active reminders can be completed");
      }

      if (!reminder.rrule) {
        await app.prisma.reminder.update({
          where: { id },
          data: {
            status: "COMPLETED",
            lastCompletedAt: now,
          },
        });
        return reply.send({ ok: true });
      }

      try {
        const currentDue = reminder.nextDueAt ?? reminder.dueAt;
        const nextDueAt = advanceRecurringDue(currentDue, reminder.rrule);

        if (isRecurrenceExpired(nextDueAt, reminder.rrule)) {
          await app.prisma.reminder.update({
            where: { id },
            data: { status: "COMPLETED", lastCompletedAt: now },
          });
          return reply.send({ ok: true });
        }

        const remindAt = computeRemindAt(reminder.dueAt, nextDueAt, reminder.remindOffsetDays);

        await app.prisma.reminder.update({
          where: { id },
          data: {
            status: "ACTIVE",
            lastCompletedAt: now,
            nextDueAt,
            remindAt,
            snoozedUntil: null,
          },
        });
      } catch (error) {
        if (error instanceof ReminderRRuleError) throw app.httpErrors.badRequest(error.message);
        throw error;
      }

      return reply.send({ ok: true });
    },
  );

  // Hides a reminder until a chosen moment.
  app.post<{ Params: { id: string } }>("/:id/snooze", { preHandler: [requireAuth] }, async (req, reply) => {
    const userId = req.userId!;
    const { id } = paramsSchema.parse(req.params);
    const body = z.object({ until: dateSchema }).strict().parse(req.body ?? {});
    const now = new Date();

    if (body.until.getTime() <= now.getTime()) {
      throw app.httpErrors.badRequest("Snooze time must be in the future");
    }

    const reminder = await app.prisma.reminder.findFirst({
      where: { id, userId },
      select: { id: true, status: true },
    });
    if (!reminder) return reply.notFound();
    if (reminder.status !== "ACTIVE") {
      throw app.httpErrors.badRequest("Only active reminders can be snoozed");
    }

    await app.prisma.reminder.update({
      where: { id },
      data: { snoozedUntil: body.until },
    });

    return reply.send({ ok: true });
  });

  // Brings a snoozed reminder back now.
  app.post<{ Params: { id: string } }>("/:id/unsnooze", { preHandler: [requireAuth] }, async (req, reply) => {
    const userId = req.userId!;
    const { id } = paramsSchema.parse(req.params);

    const reminder = await app.prisma.reminder.findFirst({
      where: { id, userId },
      select: { id: true, status: true },
    });
    if (!reminder) return reply.notFound();
    if (reminder.status !== "ACTIVE") {
      throw app.httpErrors.badRequest("Only active reminders can be unsnoozed");
    }

    await app.prisma.reminder.update({
      where: { id },
      data: { snoozedUntil: null },
    });

    return reply.send({ ok: true });
  });

  // Cancels a reminder without marking it done.
  app.post<{ Params: { id: string } }>("/:id/cancel", { preHandler: [requireAuth] }, async (req, reply) => {
    const userId = req.userId!;
    const { id } = paramsSchema.parse(req.params);

    const reminder = await app.prisma.reminder.findFirst({
      where: { id, userId },
      select: { id: true },
    });
    if (!reminder) return reply.notFound();

    await app.prisma.reminder.update({
      where: { id },
      data: { status: "CANCELED" },
    });

    return reply.send({ ok: true });
  });
};
