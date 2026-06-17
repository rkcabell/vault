"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Plus, ArrowRight } from "lucide-react";
import { usePreferences } from "@/hooks/usePreferences";
import { Button, buttonVariants } from "@/components/ui/Button";
import { AddReminderDialog } from "@/components/reminders/AddReminderDialog";
import {
  useCompleteReminder,
  useOverviewReminders,
  useRemindersSummary,
  useSnoozeReminder,
  useUnsnoozeReminder,
  type ReminderOverviewRow,
} from "@/lib/reminders";

const OVERVIEW_LIMIT = 5;
const SNOOZE_DURATION_MS = 24 * 60 * 60 * 1000;

function isCurrentlySnoozed(reminder: ReminderOverviewRow, nowMs: number) {
  return reminder.snoozedUntil !== null && new Date(reminder.snoozedUntil).getTime() > nowMs;
}

function formatDueLabel(reminder: ReminderOverviewRow, nowMs: number) {
  const dueDate = new Date(reminder.effectiveDueAt);
  const dateLabel = dueDate.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  const timeLabel = dueDate.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  const isSnoozed = isCurrentlySnoozed(reminder, nowMs);
  const prefix = isSnoozed ? "Snoozed - " : "";

  if (reminder.bucket === "overdue") return `${prefix}Overdue - due ${dateLabel} ${timeLabel}`;
  if (reminder.bucket === "today") return `${prefix}Due today at ${timeLabel}`;
  if (reminder.bucket === "soon") return `${prefix}Due soon - ${dateLabel} ${timeLabel}`;
  return `${prefix}${dateLabel}`;
}

export function OverviewRemindersCard() {
  const { prefs } = usePreferences();
  const summary = useRemindersSummary();
  const reminders = useOverviewReminders(OVERVIEW_LIMIT, prefs.soonWindowDays);
  const completeReminder = useCompleteReminder();
  const snoozeReminder = useSnoozeReminder();
  const unsnoozeReminder = useUnsnoozeReminder();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [addReminderOpen, setAddReminderOpen] = useState(false);

  const summaryText = useMemo(() => {
    if (summary.loading) return "Loading reminders...";
    if (summary.error) return "Unable to load reminders.";
    if (!summary.data || summary.data.visibleNow === 0) return "No reminders due soon.";
    return `${summary.data.visibleNow} reminders (${summary.data.overdue} overdue)`;
  }, [summary.data, summary.error, summary.loading]);

  const rows = reminders.data?.items ?? [];
  const hasRows = rows.length > 0;
  const actionsDisabled = completeReminder.isPending || snoozeReminder.isPending || unsnoozeReminder.isPending;
  const nowMs = Date.now();

  const handleComplete = async (id: string) => {
    setBusyId(id);
    try {
      await completeReminder.mutateAsync({ id });
    } finally {
      setBusyId(current => (current === id ? null : current));
    }
  };

  const handleSnooze = async (id: string) => {
    setBusyId(id);
    const until = new Date(Date.now() + SNOOZE_DURATION_MS).toISOString();
    try {
      await snoozeReminder.mutateAsync({ id, until });
    } finally {
      setBusyId(current => (current === id ? null : current));
    }
  };

  const handleUnsnooze = async (id: string) => {
    setBusyId(id);
    try {
      await unsnoozeReminder.mutateAsync({ id });
    } finally {
      setBusyId(current => (current === id ? null : current));
    }
  };

  return (
    <section className="reminders-section">
      <div className="reminders-header">
        <div className="flex items-center gap-2">
          <h2 className="reminders-title">Reminders</h2>
          {!summary.loading && summary.data && summary.data.overdue > 0 && (
            <span className="reminders-overdue-badge" title={`${summary.data.overdue} overdue`}>
              {summary.data.overdue > 99 ? "99+" : summary.data.overdue}
            </span>
          )}
        </div>
        <div className="reminders-header-actions">
          <Button size="sm" variant="outline" onClick={() => setAddReminderOpen(true)}>
            <Plus className="h-3.5 w-3.5 mr-1.5" />
            Add reminder
          </Button>
          <Link href="/reminders" className={buttonVariants({ variant: "ghost", size: "sm" })}>
            Open reminders
            <ArrowRight className="h-3.5 w-3.5 ml-1.5" />
          </Link>
        </div>
      </div>

      <div className="reminders-panel">
        <p className="reminders-summary-text">{summaryText}</p>

        {summary.error ? (
          <p className="reminders-error-text">Failed to load summary.</p>
        ) : null}

        {!hasRows && !reminders.loading ? (
          <p className="reminders-empty-text">Nothing needs action right now.</p>
        ) : null}

        {reminders.loading ? (
          <p className="reminders-loading-text">Loading list...</p>
        ) : null}

        {hasRows ? (
          <div className="reminders-list">
            {rows.map(row => {
              const isSnoozed = isCurrentlySnoozed(row, nowMs);
              const dueLabelClass = isSnoozed
                ? "reminders-row-due reminders-row-due--snoozed"
                : row.bucket === "overdue"
                ? "reminders-row-due reminders-row-due--overdue"
                : row.bucket === "today"
                ? "reminders-row-due reminders-row-due--today"
                : "reminders-row-due reminders-row-due--default";

              return (
                <div key={row.id} className="reminders-row">
                  <div className="reminders-row-main">
                    <p className="reminders-row-title">{row.title}</p>
                    <p className={dueLabelClass}>{formatDueLabel(row, nowMs)}</p>
                    {row.note ? (
                      <p className="reminders-row-note">{row.note}</p>
                    ) : null}
                  </div>
                  <div className="reminders-row-actions">
                    {isSnoozed ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void handleUnsnooze(row.id)}
                        disabled={actionsDisabled}
                      >
                        {busyId === row.id && unsnoozeReminder.isPending ? "Unsnoozed..." : "Unsnooze"}
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void handleSnooze(row.id)}
                        disabled={actionsDisabled}
                      >
                        {busyId === row.id && snoozeReminder.isPending ? "Snoozing..." : "Snooze 1d"}
                      </Button>
                    )}
                    <Button size="sm" onClick={() => void handleComplete(row.id)} disabled={actionsDisabled}>
                      {busyId === row.id && completeReminder.isPending ? "Completing..." : "Complete"}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}

        {completeReminder.error || snoozeReminder.error ? (
          <p className="reminders-error-text">
            {completeReminder.error ?? snoozeReminder.error}
          </p>
        ) : null}
      </div>

      <AddReminderDialog open={addReminderOpen} onOpenChange={setAddReminderOpen} />
    </section>
  );
}
