/**
 * Works out when a reminder should start showing and which group it belongs
 * to on the reminders screen.
 */
import { DAY_IN_MS, DEFAULT_REMINDER_OFFSET_DAYS, SOON_WINDOW_DAYS } from "./constants.js";

/** The four groups a reminder is shown under, from most to least urgent. */
export type ReminderBucket = "overdue" | "today" | "soon" | "later";

const dateKeyFormatters = new Map<string, Intl.DateTimeFormat>();

// Building an Intl.DateTimeFormat is expensive, so one is kept per timezone.
function getDateKeyFormatter(timezone: string) {
  const cached = dateKeyFormatters.get(timezone);
  if (cached) return cached;

  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  dateKeyFormatters.set(timezone, formatter);
  return formatter;
}

// Returns the calendar date in `timezone` as YYYY-MM-DD, for comparing two
// moments by day rather than by elapsed time.
function getDateKey(date: Date, timezone: string) {
  return getDateKeyFormatter(timezone).format(date);
}

/**
 * Returns an IANA timezone name that the date formatter accepts.
 *
 * A missing, blank or unrecognized `timezone` becomes UTC rather than an
 * error, so a bad stored value cannot break the reminders screen.
 */
export function normalizeTimezone(timezone: string | null | undefined) {
  const candidate = timezone?.trim();
  if (!candidate) return "UTC";

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(new Date());
    return candidate;
  } catch {
    return "UTC";
  }
}

/** Returns the date a reminder is currently counting down to. For a recurring reminder that is the next occurrence, not the original due date. */
export function getEffectiveDueAt(dueAt: Date, nextDueAt: Date | null) {
  return nextDueAt ?? dueAt;
}

/** Returns the moment a reminder starts appearing, which is `remindOffsetDays` before it comes due. */
export function computeRemindAt(
  dueAt: Date,
  nextDueAt: Date | null,
  remindOffsetDays: number | null,
) {
  const effectiveDueAt = getEffectiveDueAt(dueAt, nextDueAt);
  const offsetDays = remindOffsetDays ?? DEFAULT_REMINDER_OFFSET_DAYS;
  return new Date(effectiveDueAt.getTime() - offsetDays * DAY_IN_MS);
}

/** True if `now` has reached `remindAt` and the reminder is not still snoozed. */
export function isVisibleNow(remindAt: Date, snoozedUntil: Date | null, now: Date) {
  if (now.getTime() < remindAt.getTime()) return false;
  if (!snoozedUntil) return true;
  return now.getTime() >= snoozedUntil.getTime();
}

/**
 * Returns the group a reminder is shown under.
 *
 * Today means the same calendar date in the reminder's own timezone, not the
 * next 24 hours. A reminder already past its due date is overdue even if that
 * date is today.
 */
export function getReminderBucket(
  effectiveDueAt: Date,
  timezone: string,
  now: Date,
  soonWindowDays = SOON_WINDOW_DAYS,
): ReminderBucket {
  if (effectiveDueAt.getTime() < now.getTime()) return "overdue";

  const normalizedTimezone = normalizeTimezone(timezone);
  if (getDateKey(effectiveDueAt, normalizedTimezone) === getDateKey(now, normalizedTimezone)) {
    return "today";
  }

  if (effectiveDueAt.getTime() <= now.getTime() + soonWindowDays * DAY_IN_MS) {
    return "soon";
  }

  return "later";
}

/** Sort positions for the groups, used to order the reminders screen. */
export const REMINDER_BUCKET_ORDER: Record<ReminderBucket, number> = {
  overdue: 0,
  today: 1,
  soon: 2,
  later: 3,
};
