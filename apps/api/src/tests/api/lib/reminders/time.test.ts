import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeTimezone,
  getEffectiveDueAt,
  computeRemindAt,
  isVisibleNow,
  getReminderBucket,
} from "@/lib/reminders/time.js";
import { DAY_IN_MS, DEFAULT_REMINDER_OFFSET_DAYS, SOON_WINDOW_DAYS } from "@/lib/reminders/constants.js";

// ── normalizeTimezone ─────────────────────────────────────────────────────────

test("normalizeTimezone: returns a valid timezone unchanged", () => {
  assert.equal(normalizeTimezone("America/New_York"), "America/New_York");
  assert.equal(normalizeTimezone("Europe/London"), "Europe/London");
  assert.equal(normalizeTimezone("UTC"), "UTC");
  assert.equal(normalizeTimezone("Asia/Tokyo"), "Asia/Tokyo");
});

test("normalizeTimezone: trims whitespace before validating", () => {
  assert.equal(normalizeTimezone("  America/Chicago  "), "America/Chicago");
});

test("normalizeTimezone: returns UTC for null", () => {
  assert.equal(normalizeTimezone(null), "UTC");
});

test("normalizeTimezone: returns UTC for undefined", () => {
  assert.equal(normalizeTimezone(undefined), "UTC");
});

test("normalizeTimezone: returns UTC for empty string", () => {
  assert.equal(normalizeTimezone(""), "UTC");
});

test("normalizeTimezone: returns UTC for blank whitespace string", () => {
  assert.equal(normalizeTimezone("   "), "UTC");
});

test("normalizeTimezone: returns UTC for an invalid timezone", () => {
  assert.equal(normalizeTimezone("Not/AReal_Timezone"), "UTC");
  assert.equal(normalizeTimezone("garbage"), "UTC");
  assert.equal(normalizeTimezone("America/FakeCity"), "UTC");
});

// ── getEffectiveDueAt ─────────────────────────────────────────────────────────

test("getEffectiveDueAt: returns dueAt when nextDueAt is null", () => {
  const dueAt = new Date("2026-06-01T00:00:00Z");
  assert.equal(getEffectiveDueAt(dueAt, null), dueAt);
});

test("getEffectiveDueAt: returns nextDueAt when provided", () => {
  const dueAt = new Date("2026-06-01T00:00:00Z");
  const nextDueAt = new Date("2026-07-01T00:00:00Z");
  assert.equal(getEffectiveDueAt(dueAt, nextDueAt), nextDueAt);
});

test("getEffectiveDueAt: nextDueAt takes precedence even when earlier than dueAt", () => {
  const dueAt = new Date("2026-06-15T00:00:00Z");
  const nextDueAt = new Date("2026-06-01T00:00:00Z");
  assert.equal(getEffectiveDueAt(dueAt, nextDueAt), nextDueAt);
});

// ── computeRemindAt ───────────────────────────────────────────────────────────

test("computeRemindAt: applies default offset when remindOffsetDays is null", () => {
  const dueAt = new Date("2026-06-10T00:00:00Z");
  const result = computeRemindAt(dueAt, null, null);
  const expected = new Date(dueAt.getTime() - DEFAULT_REMINDER_OFFSET_DAYS * DAY_IN_MS);
  assert.equal(result.getTime(), expected.getTime());
});

test("computeRemindAt: applies custom offset", () => {
  const dueAt = new Date("2026-06-10T00:00:00Z");
  const result = computeRemindAt(dueAt, null, 3);
  const expected = new Date(dueAt.getTime() - 3 * DAY_IN_MS);
  assert.equal(result.getTime(), expected.getTime());
});

test("computeRemindAt: offset of 0 returns the due date itself", () => {
  const dueAt = new Date("2026-06-10T00:00:00Z");
  const result = computeRemindAt(dueAt, null, 0);
  assert.equal(result.getTime(), dueAt.getTime());
});

test("computeRemindAt: uses nextDueAt over dueAt when provided", () => {
  const dueAt = new Date("2026-06-10T00:00:00Z");
  const nextDueAt = new Date("2026-07-10T00:00:00Z");
  const result = computeRemindAt(dueAt, nextDueAt, 1);
  const expected = new Date(nextDueAt.getTime() - 1 * DAY_IN_MS);
  assert.equal(result.getTime(), expected.getTime());
});

// ── isVisibleNow ──────────────────────────────────────────────────────────────

test("isVisibleNow: not visible before remindAt", () => {
  const remindAt = new Date("2026-06-10T12:00:00Z");
  const now = new Date("2026-06-10T11:59:59Z");
  assert.equal(isVisibleNow(remindAt, null, now), false);
});

test("isVisibleNow: visible exactly at remindAt", () => {
  const remindAt = new Date("2026-06-10T12:00:00Z");
  assert.equal(isVisibleNow(remindAt, null, remindAt), true);
});

test("isVisibleNow: visible after remindAt with no snooze", () => {
  const remindAt = new Date("2026-06-10T12:00:00Z");
  const now = new Date("2026-06-10T13:00:00Z");
  assert.equal(isVisibleNow(remindAt, null, now), true);
});

test("isVisibleNow: not visible while snoozed", () => {
  const remindAt = new Date("2026-06-10T12:00:00Z");
  const snoozedUntil = new Date("2026-06-10T14:00:00Z");
  const now = new Date("2026-06-10T13:00:00Z");
  assert.equal(isVisibleNow(remindAt, snoozedUntil, now), false);
});

test("isVisibleNow: visible once snooze has expired", () => {
  const remindAt = new Date("2026-06-10T12:00:00Z");
  const snoozedUntil = new Date("2026-06-10T14:00:00Z");
  const now = new Date("2026-06-10T14:00:00Z");
  assert.equal(isVisibleNow(remindAt, snoozedUntil, now), true);
});

test("isVisibleNow: not visible before remindAt even if snooze already expired", () => {
  const remindAt = new Date("2026-06-10T12:00:00Z");
  const snoozedUntil = new Date("2026-06-09T08:00:00Z"); // snooze is in the past
  const now = new Date("2026-06-10T11:00:00Z");           // but remindAt not reached
  assert.equal(isVisibleNow(remindAt, snoozedUntil, now), false);
});

// ── getReminderBucket ─────────────────────────────────────────────────────────

test("getReminderBucket: overdue when effectiveDueAt is in the past", () => {
  const now = new Date("2026-06-10T12:00:00Z");
  const dueAt = new Date("2026-06-09T12:00:00Z");
  assert.equal(getReminderBucket(dueAt, "UTC", now), "overdue");
});

test("getReminderBucket: overdue when due 1ms ago", () => {
  const now = new Date("2026-06-10T12:00:00.000Z");
  const dueAt = new Date(now.getTime() - 1);
  assert.equal(getReminderBucket(dueAt, "UTC", now), "overdue");
});

test("getReminderBucket: today when due later the same calendar day (UTC)", () => {
  const now = new Date("2026-06-10T08:00:00Z");
  const dueAt = new Date("2026-06-10T23:59:59Z");
  assert.equal(getReminderBucket(dueAt, "UTC", now), "today");
});

test("getReminderBucket: today is timezone-aware — same local day counts", () => {
  // 2026-06-10 23:30 UTC = 2026-06-10 19:30 America/New_York (EDT, UTC-4)
  // dueAt = 2026-06-11 02:00 UTC = 2026-06-10 22:00 in New_York → same local day
  const now = new Date("2026-06-10T23:30:00Z");
  const dueAt = new Date("2026-06-11T02:00:00Z");
  assert.equal(getReminderBucket(dueAt, "America/New_York", now), "today");
});

test("getReminderBucket: not today in UTC when different UTC day even if close", () => {
  // now = 2026-06-10 23:00 UTC, due = 2026-06-11 00:30 UTC — different UTC day
  const now = new Date("2026-06-10T23:00:00Z");
  const dueAt = new Date("2026-06-11T00:30:00Z");
  // In UTC these are different days, should be "soon" (within 7 days)
  assert.equal(getReminderBucket(dueAt, "UTC", now), "soon");
});

test("getReminderBucket: soon when within the default soon window", () => {
  const now = new Date("2026-06-10T00:00:00Z");
  const dueAt = new Date(now.getTime() + SOON_WINDOW_DAYS * DAY_IN_MS - 1);
  assert.equal(getReminderBucket(dueAt, "UTC", now), "soon");
});

test("getReminderBucket: soon boundary — exactly at soonWindowDays", () => {
  const now = new Date("2026-06-10T00:00:00Z");
  // exactly soonWindowDays away (inclusive)
  const dueAt = new Date(now.getTime() + SOON_WINDOW_DAYS * DAY_IN_MS);
  assert.equal(getReminderBucket(dueAt, "UTC", now), "soon");
});

test("getReminderBucket: later when beyond the soon window", () => {
  const now = new Date("2026-06-10T00:00:00Z");
  const dueAt = new Date(now.getTime() + (SOON_WINDOW_DAYS + 1) * DAY_IN_MS + 1);
  assert.equal(getReminderBucket(dueAt, "UTC", now), "later");
});

test("getReminderBucket: respects custom soonWindowDays", () => {
  const now = new Date("2026-06-10T00:00:00Z");
  // 3 days out, custom window of 2 → should be "later"
  const dueAt = new Date(now.getTime() + 3 * DAY_IN_MS);
  assert.equal(getReminderBucket(dueAt, "UTC", now, 2), "later");
  // same date, window of 4 → should be "soon"
  assert.equal(getReminderBucket(dueAt, "UTC", now, 4), "soon");
});

test("getReminderBucket: falls back to UTC for invalid timezone", () => {
  const now = new Date("2026-06-10T08:00:00Z");
  const dueAt = new Date("2026-06-10T23:00:00Z");
  // Invalid tz → normalizes to UTC; same UTC day → "today"
  assert.equal(getReminderBucket(dueAt, "Not/Valid", now), "today");
});
