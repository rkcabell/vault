/**
 * Fixed reminder scheduling values, used when a reminder or a user preference
 * does not supply its own.
 */

/** Days before the due date that a reminder starts appearing, for reminders with no offset of their own. */
export const DEFAULT_REMINDER_OFFSET_DAYS = 7;
/** Days ahead of now within which a reminder is grouped as due soon rather than later. */
export const SOON_WINDOW_DAYS = 7;
export const DAY_IN_MS = 24 * 60 * 60 * 1000;
