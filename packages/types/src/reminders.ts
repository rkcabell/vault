import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared enums
// ---------------------------------------------------------------------------

export const ReminderStatusSchema = z.enum(["active", "completed", "canceled"]);
export type ReminderStatus = z.infer<typeof ReminderStatusSchema>;

export const ReminderBucketSchema = z.enum(["overdue", "today", "soon", "later"]);
export type ReminderBucket = z.infer<typeof ReminderBucketSchema>;

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

export const ReminderOverviewRowSchema = z.object({
  id: z.string(),
  title: z.string(),
  note: z.string().nullable(),
  media: z.object({ id: z.string(), title: z.string() }).nullable(),
  effectiveDueAt: z.string(), // ISO date string
  remindAt: z.string(),
  snoozedUntil: z.string().nullable(),
  bucket: ReminderBucketSchema,
  isOverdue: z.boolean(),
  remindOffsetDays: z.number().nullable(),
});
export type ReminderOverviewRow = z.infer<typeof ReminderOverviewRowSchema>;

export const ReminderCompletedRowSchema = z.object({
  id: z.string(),
  title: z.string(),
  note: z.string().nullable(),
  media: z.object({ id: z.string(), title: z.string() }).nullable(),
  lastCompletedAt: z.string(),
  dueAt: z.string(),
});
export type ReminderCompletedRow = z.infer<typeof ReminderCompletedRowSchema>;

export const RemindersSummarySchema = z.object({
  visibleNow: z.number(),
  overdue: z.number(),
  dueToday: z.number(),
  dueSoon: z.number(),
  totalActive: z.number(),
  soonWindowDays: z.number(),
});
export type RemindersSummary = z.infer<typeof RemindersSummarySchema>;

export const ReminderOutputSchema = z.object({
  id: z.string(),
  userId: z.string(),
  title: z.string(),
  note: z.string().nullable(),
  mediaId: z.string().nullable(),
  status: ReminderStatusSchema,
  timezone: z.string(),
  dueAt: z.string(),
  nextDueAt: z.string().nullable(),
  remindOffsetDays: z.number().nullable(),
  remindAt: z.string(),
  snoozedUntil: z.string().nullable(),
  rrule: z.string().nullable(),
  lastCompletedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ReminderOutput = z.infer<typeof ReminderOutputSchema>;

export const OverviewResponseSchema = z.object({
  items: z.array(ReminderOverviewRowSchema),
});
export type OverviewResponse = z.infer<typeof OverviewResponseSchema>;

export const CompletedRemindersResponseSchema = z.object({
  items: z.array(ReminderCompletedRowSchema),
});
export type CompletedRemindersResponse = z.infer<typeof CompletedRemindersResponseSchema>;

// ---------------------------------------------------------------------------
// Request input types  (used by the web client when calling the API)
// ---------------------------------------------------------------------------

export const CreateReminderInputSchema = z.object({
  title: z.string(),
  note: z.string().nullable().optional(),
  mediaId: z.string().nullable().optional(),
  dueAt: z.string(), // ISO date string
  remindOffsetDays: z.number().nullable().optional(),
  rrule: z.string().nullable().optional(),
});
export type CreateReminderInput = z.infer<typeof CreateReminderInputSchema>;

export const UpdateReminderInputSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  note: z.string().nullable().optional(),
  mediaId: z.string().nullable().optional(),
  dueAt: z.string().optional(),
  remindOffsetDays: z.number().nullable().optional(),
  rrule: z.string().nullable().optional(),
});
export type UpdateReminderInput = z.infer<typeof UpdateReminderInputSchema>;
