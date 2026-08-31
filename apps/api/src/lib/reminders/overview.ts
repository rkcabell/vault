/**
 * Builds the short reminders panel shown on the overview screen, together with
 * the counts displayed beside it.
 */
import type { PrismaClient } from "@prisma/client";
import { SOON_WINDOW_DAYS } from "./constants.js";
import { REMINDER_BUCKET_ORDER, getEffectiveDueAt, getReminderBucket } from "./time.js";
import type { ReminderBucket } from "./time.js";

// Grouping and sorting happen in memory because the group a reminder falls in
// depends on its own timezone, which the database cannot order by. The query
// therefore reads far more rows than the panel shows.
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

type OverviewDbRow = {
  id: string;
  title: string;
  note: string | null;
  dueAt: Date;
  nextDueAt: Date | null;
  remindAt: Date;
  snoozedUntil: Date | null;
  timezone: string;
  remindOffsetDays: number | null;
  media: { id: string; title: string } | null;
};

/** One reminder as the overview screen renders it, with dates already turned into strings. */
export type OverviewRow = {
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
};

/** Totals across every reminder visible now, not only the few the panel lists. */
export type OverviewCounts = {
  visibleNow: number;
  overdue: number;
  dueToday: number;
  dueSoon: number;
};

/**
 * Returns the reminders to show on the overview screen and the counts beside
 * them.
 *
 * Counts cover only reminders that are visible now. When too few of those
 * exist to fill the panel, it is padded with reminders that are still snoozed
 * or not yet due, and those padding rows are not counted.
 */
export async function buildReminderOverview(
  userId: string,
  prisma: PrismaClient,
  soonWindowDays: number,
  now: Date,
): Promise<{ items: OverviewRow[]; counts: OverviewCounts }> {
  const visible = await prisma.reminder.findMany({
    where: {
      userId,
      status: "ACTIVE",
      remindAt: { lte: now },
      OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: now } }],
    },
    take: OVERVIEW_PREFETCH,
    select: overviewSelect,
  });

  const effectiveSoonWindowDays = soonWindowDays ?? SOON_WINDOW_DAYS;

  const toRow = (r: OverviewDbRow): OverviewRow => {
    const effectiveDueAt = getEffectiveDueAt(r.dueAt, r.nextDueAt);
    const bucket = getReminderBucket(effectiveDueAt, r.timezone, now, effectiveSoonWindowDays);
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

  // Snoozed reminders sort below everything else, then by group, then by due date.
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

  const counts: OverviewCounts = { visibleNow: visibleRows.length, overdue: 0, dueToday: 0, dueSoon: 0 };
  for (const row of visibleRows) {
    if (row.bucket === "overdue") counts.overdue += 1;
    else if (row.bucket === "today") counts.dueToday += 1;
    else if (row.bucket === "soon") counts.dueSoon += 1;
  }

  let overviewItems = visibleRows.slice(0, OVERVIEW_LIMIT);

  if (visibleRows.length < OVERVIEW_LIMIT) {
    const remaining = OVERVIEW_LIMIT - visibleRows.length;
    const hidden = await prisma.reminder.findMany({
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
}
