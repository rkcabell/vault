import test from "node:test";
import assert from "node:assert/strict";
import { advanceRecurringDue, validateRRule, ReminderRRuleError } from "@/lib/reminders/recurrence.js";

// ── helpers ───────────────────────────────────────────────────────────────────

function expectRRuleError(fn: () => unknown) {
  assert.throws(fn, (err: unknown) => err instanceof ReminderRRuleError);
}

// ── validateRRule ─────────────────────────────────────────────────────────────

test("validateRRule: accepts valid FREQ-only rules", () => {
  assert.doesNotThrow(() => validateRRule("FREQ=DAILY"));
  assert.doesNotThrow(() => validateRRule("FREQ=WEEKLY"));
  assert.doesNotThrow(() => validateRRule("FREQ=MONTHLY"));
  assert.doesNotThrow(() => validateRRule("FREQ=YEARLY"));
});

test("validateRRule: accepts FREQ with INTERVAL", () => {
  assert.doesNotThrow(() => validateRRule("FREQ=DAILY;INTERVAL=2"));
  assert.doesNotThrow(() => validateRRule("FREQ=WEEKLY;INTERVAL=3"));
});

test("validateRRule: is case-insensitive", () => {
  assert.doesNotThrow(() => validateRRule("freq=daily"));
  assert.doesNotThrow(() => validateRRule("freq=daily;interval=2"));
});

test("validateRRule: trims whitespace around the rule and components", () => {
  assert.doesNotThrow(() => validateRRule("  FREQ=DAILY  "));
  assert.doesNotThrow(() => validateRRule("FREQ=WEEKLY ; INTERVAL=2"));
});

test("validateRRule: rejects empty string", () => {
  expectRRuleError(() => validateRRule(""));
});

test("validateRRule: rejects whitespace-only string", () => {
  expectRRuleError(() => validateRRule("   "));
});

test("validateRRule: rejects rule with no FREQ", () => {
  expectRRuleError(() => validateRRule("INTERVAL=1"));
});

test("validateRRule: rejects unsupported FREQ", () => {
  expectRRuleError(() => validateRRule("FREQ=HOURLY"));
  expectRRuleError(() => validateRRule("FREQ=MINUTELY"));
});

test("validateRRule: rejects unknown keys", () => {
  expectRRuleError(() => validateRRule("FREQ=DAILY;BYDAY=MO"));
  expectRRuleError(() => validateRRule("FREQ=WEEKLY;COUNT=5"));
});

test("validateRRule: rejects INTERVAL=0", () => {
  expectRRuleError(() => validateRRule("FREQ=DAILY;INTERVAL=0"));
});

test("validateRRule: rejects negative INTERVAL", () => {
  expectRRuleError(() => validateRRule("FREQ=DAILY;INTERVAL=-1"));
});

test("validateRRule: rejects malformed component (no equals sign)", () => {
  expectRRuleError(() => validateRRule("FREQ=DAILY;WEEKLY"));
});

// ── advanceRecurringDue — DAILY ───────────────────────────────────────────────

test("DAILY interval=1 advances by exactly 1 day", () => {
  const start = new Date("2026-06-10T09:00:00Z");
  const result = advanceRecurringDue(start, "FREQ=DAILY");
  assert.equal(result.toISOString(), "2026-06-11T09:00:00.000Z");
});

test("DAILY interval=3 advances by 3 days", () => {
  const start = new Date("2026-06-10T00:00:00Z");
  const result = advanceRecurringDue(start, "FREQ=DAILY;INTERVAL=3");
  assert.equal(result.toISOString(), "2026-06-13T00:00:00.000Z");
});

test("DAILY preserves time-of-day", () => {
  const start = new Date("2026-06-10T14:30:00.500Z");
  const result = advanceRecurringDue(start, "FREQ=DAILY");
  assert.equal(result.toISOString(), "2026-06-11T14:30:00.500Z");
});

test("DAILY crosses month boundary correctly", () => {
  const start = new Date("2026-01-31T00:00:00Z");
  const result = advanceRecurringDue(start, "FREQ=DAILY");
  assert.equal(result.toISOString(), "2026-02-01T00:00:00.000Z");
});

// ── advanceRecurringDue — WEEKLY ──────────────────────────────────────────────

test("WEEKLY interval=1 advances by exactly 7 days", () => {
  const start = new Date("2026-06-10T00:00:00Z");
  const result = advanceRecurringDue(start, "FREQ=WEEKLY");
  assert.equal(result.toISOString(), "2026-06-17T00:00:00.000Z");
});

test("WEEKLY interval=2 advances by 14 days", () => {
  const start = new Date("2026-06-10T00:00:00Z");
  const result = advanceRecurringDue(start, "FREQ=WEEKLY;INTERVAL=2");
  assert.equal(result.toISOString(), "2026-06-24T00:00:00.000Z");
});

// ── advanceRecurringDue — MONTHLY ─────────────────────────────────────────────

test("MONTHLY interval=1 advances to same day next month", () => {
  const start = new Date("2026-06-10T00:00:00Z");
  const result = advanceRecurringDue(start, "FREQ=MONTHLY");
  assert.equal(result.toISOString(), "2026-07-10T00:00:00.000Z");
});

test("MONTHLY interval=2 advances two months", () => {
  const start = new Date("2026-01-15T00:00:00Z");
  const result = advanceRecurringDue(start, "FREQ=MONTHLY;INTERVAL=2");
  assert.equal(result.toISOString(), "2026-03-15T00:00:00.000Z");
});

test("MONTHLY clamps to end of shorter month (Jan 31 → Feb 28)", () => {
  const start = new Date("2026-01-31T00:00:00Z");
  const result = advanceRecurringDue(start, "FREQ=MONTHLY");
  assert.equal(result.toISOString(), "2026-02-28T00:00:00.000Z");
});

test("MONTHLY clamps to end of shorter month (Mar 31 → Apr 30)", () => {
  const start = new Date("2026-03-31T00:00:00Z");
  const result = advanceRecurringDue(start, "FREQ=MONTHLY");
  assert.equal(result.toISOString(), "2026-04-30T00:00:00.000Z");
});

test("MONTHLY on Feb 29 (leap) advances to Feb 28 in non-leap year", () => {
  const start = new Date("2024-02-29T00:00:00Z"); // 2024 is a leap year
  const result = advanceRecurringDue(start, "FREQ=YEARLY"); // +12 months → 2025-02-28
  assert.equal(result.toISOString(), "2025-02-28T00:00:00.000Z");
});

test("MONTHLY on Feb 29 (leap) stays Feb 29 in next leap year via YEARLY", () => {
  const start = new Date("2024-02-29T00:00:00Z");
  const result = advanceRecurringDue(start, "FREQ=YEARLY;INTERVAL=4"); // 2028 is leap
  assert.equal(result.toISOString(), "2028-02-29T00:00:00.000Z");
});

test("MONTHLY preserves time-of-day", () => {
  const start = new Date("2026-06-15T22:45:30.123Z");
  const result = advanceRecurringDue(start, "FREQ=MONTHLY");
  assert.equal(result.toISOString(), "2026-07-15T22:45:30.123Z");
});

test("MONTHLY crosses year boundary", () => {
  const start = new Date("2026-12-01T00:00:00Z");
  const result = advanceRecurringDue(start, "FREQ=MONTHLY");
  assert.equal(result.toISOString(), "2027-01-01T00:00:00.000Z");
});

// ── advanceRecurringDue — YEARLY ──────────────────────────────────────────────

test("YEARLY interval=1 advances by 12 months", () => {
  const start = new Date("2026-06-10T00:00:00Z");
  const result = advanceRecurringDue(start, "FREQ=YEARLY");
  assert.equal(result.toISOString(), "2027-06-10T00:00:00.000Z");
});

test("YEARLY interval=2 advances by 24 months", () => {
  const start = new Date("2026-03-15T00:00:00Z");
  const result = advanceRecurringDue(start, "FREQ=YEARLY;INTERVAL=2");
  assert.equal(result.toISOString(), "2028-03-15T00:00:00.000Z");
});

test("YEARLY is equivalent to MONTHLY with INTERVAL=12 for normal dates", () => {
  const start = new Date("2026-07-20T00:00:00Z");
  const yearly = advanceRecurringDue(start, "FREQ=YEARLY");
  const monthly12 = advanceRecurringDue(start, "FREQ=MONTHLY;INTERVAL=12");
  assert.equal(yearly.getTime(), monthly12.getTime());
});

// ── advanceRecurringDue — error propagation ───────────────────────────────────

test("advanceRecurringDue throws ReminderRRuleError for invalid rrule", () => {
  const start = new Date("2026-06-10T00:00:00Z");
  expectRRuleError(() => advanceRecurringDue(start, ""));
  expectRRuleError(() => advanceRecurringDue(start, "INTERVAL=1"));
  expectRRuleError(() => advanceRecurringDue(start, "FREQ=HOURLY"));
});
