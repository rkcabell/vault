import { DAY_IN_MS, DEFAULT_REMINDER_OFFSET_DAYS, SOON_WINDOW_DAYS } from "./constants.js";

export type ReminderBucket = "overdue" | "today" | "soon" | "later";

const dateKeyFormatters = new Map<string, Intl.DateTimeFormat>();

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

function getDateKey(date: Date, timezone: string) {
  return getDateKeyFormatter(timezone).format(date);
}

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

export function getEffectiveDueAt(dueAt: Date, nextDueAt: Date | null) {
  return nextDueAt ?? dueAt;
}

export function computeRemindAt(
  dueAt: Date,
  nextDueAt: Date | null,
  remindOffsetDays: number | null,
) {
  const effectiveDueAt = getEffectiveDueAt(dueAt, nextDueAt);
  const offsetDays = remindOffsetDays ?? DEFAULT_REMINDER_OFFSET_DAYS;
  return new Date(effectiveDueAt.getTime() - offsetDays * DAY_IN_MS);
}

export function isVisibleNow(remindAt: Date, snoozedUntil: Date | null, now: Date) {
  if (now.getTime() < remindAt.getTime()) return false;
  if (!snoozedUntil) return true;
  return now.getTime() >= snoozedUntil.getTime();
}

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

export const REMINDER_BUCKET_ORDER: Record<ReminderBucket, number> = {
  overdue: 0,
  today: 1,
  soon: 2,
  later: 3,
};
