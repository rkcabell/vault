type RecurrenceFrequency = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";

type ParsedRRule = {
  frequency: RecurrenceFrequency;
  interval: number;
  until?: Date;
};

const SUPPORTED_KEYS = new Set(["FREQ", "INTERVAL", "UNTIL"]);
const SUPPORTED_FREQUENCIES = new Set<RecurrenceFrequency>([
  "DAILY",
  "WEEKLY",
  "MONTHLY",
  "YEARLY",
]);

export class ReminderRRuleError extends Error {}

function parsePositiveInt(value: string, key: string) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new ReminderRRuleError(`RRULE ${key} must be a positive integer`);
  }
  return parsed;
}

function parseRRule(rrule: string): ParsedRRule {
  const trimmed = rrule.trim();
  if (!trimmed) throw new ReminderRRuleError("RRULE cannot be empty");

  const entries = trimmed.split(";").map(entry => entry.trim()).filter(Boolean);
  if (entries.length === 0) throw new ReminderRRuleError("RRULE cannot be empty");

  const values = new Map<string, string>();
  for (const entry of entries) {
    const [rawKey, rawValue] = entry.split("=");
    const key = rawKey?.trim().toUpperCase();
    const value = rawValue?.trim().toUpperCase();
    if (!key || !value) throw new ReminderRRuleError(`Invalid RRULE component: ${entry}`);
    if (!SUPPORTED_KEYS.has(key)) {
      throw new ReminderRRuleError(`Unsupported RRULE key: ${key}`);
    }
    values.set(key, value);
  }

  const frequencyRaw = values.get("FREQ");
  if (!frequencyRaw) throw new ReminderRRuleError("RRULE must include FREQ");
  if (!SUPPORTED_FREQUENCIES.has(frequencyRaw as RecurrenceFrequency)) {
    throw new ReminderRRuleError(`Unsupported RRULE FREQ: ${frequencyRaw}`);
  }

  const intervalRaw = values.get("INTERVAL");
  const interval = intervalRaw ? parsePositiveInt(intervalRaw, "INTERVAL") : 1;

  let until: Date | undefined;
  const untilRaw = values.get("UNTIL");
  if (untilRaw) {
    const parsed = new Date(untilRaw);
    if (Number.isNaN(parsed.getTime())) throw new ReminderRRuleError("RRULE UNTIL is not a valid date");
    until = parsed;
  }

  return {
    frequency: frequencyRaw as RecurrenceFrequency,
    interval,
    ...(until ? { until } : {}),
  };
}

function addMonths(date: Date, months: number) {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  const hour = date.getUTCHours();
  const minute = date.getUTCMinutes();
  const second = date.getUTCSeconds();
  const millisecond = date.getUTCMilliseconds();

  const firstOfTarget = new Date(Date.UTC(year, month + months, 1, hour, minute, second, millisecond));
  const daysInTargetMonth = new Date(
    Date.UTC(firstOfTarget.getUTCFullYear(), firstOfTarget.getUTCMonth() + 1, 0),
  ).getUTCDate();
  const targetDay = Math.min(day, daysInTargetMonth);

  return new Date(
    Date.UTC(
      firstOfTarget.getUTCFullYear(),
      firstOfTarget.getUTCMonth(),
      targetDay,
      hour,
      minute,
      second,
      millisecond,
    ),
  );
}

export function advanceRecurringDue(currentDueAt: Date, rrule: string) {
  const { frequency, interval } = parseRRule(rrule);

  if (frequency === "DAILY") {
    return new Date(currentDueAt.getTime() + interval * 24 * 60 * 60 * 1000);
  }

  if (frequency === "WEEKLY") {
    return new Date(currentDueAt.getTime() + interval * 7 * 24 * 60 * 60 * 1000);
  }

  if (frequency === "MONTHLY") {
    return addMonths(currentDueAt, interval);
  }

  return addMonths(currentDueAt, interval * 12);
}

export function validateRRule(rrule: string) {
  parseRRule(rrule);
}

/** Returns true when the given next-due date is past the UNTIL bound in the rrule. */
export function isRecurrenceExpired(nextDue: Date, rrule: string): boolean {
  const { until } = parseRRule(rrule);
  return until !== undefined && nextDue.getTime() > until.getTime();
}
