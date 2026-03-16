"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Skeleton";
import { AddReminderDialog } from "@/components/reminders/AddReminderDialog";
import { EditReminderDialog } from "@/components/reminders/EditReminderDialog";
import {
  useAllActiveReminders,
  useCompleteReminder,
  useSnoozeReminder,
  useCancelReminder,
  useRemindersSummary,
  type ReminderOverviewRow,
  type ReminderBucket,
} from "@/lib/reminders";

const SNOOZE_DURATION_MS = 24 * 60 * 60 * 1000;

const BUCKET_LABELS: Record<ReminderBucket, string> = {
  overdue: "Overdue",
  today: "Due today",
  soon: "Coming up",
  later: "Later",
};

function isCurrentlySnoozed(reminder: ReminderOverviewRow, nowMs: number) {
  return reminder.snoozedUntil !== null && new Date(reminder.snoozedUntil).getTime() > nowMs;
}

function formatDueLabel(reminder: ReminderOverviewRow, nowMs: number) {
  const dueDate = new Date(reminder.effectiveDueAt);
  const dateLabel = dueDate.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const timeLabel = dueDate.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  const isSnoozed = isCurrentlySnoozed(reminder, nowMs);
  const snoozedPrefix = isSnoozed ? "Snoozed · " : "";

  if (reminder.bucket === "overdue") return `${snoozedPrefix}Overdue · ${dateLabel} ${timeLabel}`;
  if (reminder.bucket === "today") return `${snoozedPrefix}Today at ${timeLabel}`;
  if (reminder.bucket === "soon") return `${snoozedPrefix}${dateLabel}`;
  return `${snoozedPrefix}${dateLabel}`;
}

type BucketGroup = {
  bucket: ReminderBucket;
  rows: ReminderOverviewRow[];
};

function groupByBucket(items: ReminderOverviewRow[]): BucketGroup[] {
  const order: ReminderBucket[] = ["overdue", "today", "soon", "later"];
  const map = new Map<ReminderBucket, ReminderOverviewRow[]>();
  for (const item of items) {
    const existing = map.get(item.bucket);
    if (existing) {
      existing.push(item);
    } else {
      map.set(item.bucket, [item]);
    }
  }
  return order.filter(b => map.has(b)).map(b => ({ bucket: b, rows: map.get(b)! }));
}

type ReminderRowProps = {
  row: ReminderOverviewRow;
  nowMs: number;
  busyId: string | null;
  actionsDisabled: boolean;
  completeIsPending: boolean;
  snoozeIsPending: boolean;
  onEdit: (row: ReminderOverviewRow) => void;
  onSnooze: (id: string) => void;
  onComplete: (id: string) => void;
  onCancel: (id: string) => void;
};

function ReminderRow({
  row,
  nowMs,
  busyId,
  actionsDisabled,
  completeIsPending,
  snoozeIsPending,
  onEdit,
  onSnooze,
  onComplete,
  onCancel,
}: ReminderRowProps) {
  const isSnoozed = isCurrentlySnoozed(row, nowMs);
  const isBusy = busyId === row.id;

  const dueLabelClass = isSnoozed
    ? "reminders-row-due reminders-row-due--snoozed"
    : row.bucket === "overdue"
      ? "reminders-row-due reminders-row-due--overdue"
      : row.bucket === "today"
        ? "reminders-row-due reminders-row-due--today"
        : "reminders-row-due reminders-row-due--default";

  return (
    <div className="reminders-full-row">
      <div className="reminders-full-row-top">
        <p className="reminders-row-title">{row.title}</p>
        <div className="reminders-row-actions">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onEdit(row)}
            disabled={actionsDisabled}
            aria-label="Edit reminder"
          >
            Edit
          </Button>
          {(row.bucket === "overdue" || row.bucket === "today" || row.bucket === "soon") && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => onSnooze(row.id)}
              disabled={actionsDisabled}
            >
              {isBusy && snoozeIsPending ? "Snoozing..." : "Snooze 1d"}
            </Button>
          )}
          <Button
            size="sm"
            onClick={() => onComplete(row.id)}
            disabled={actionsDisabled}
          >
            {isBusy && completeIsPending ? "Completing..." : "Complete"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => onCancel(row.id)}
            disabled={actionsDisabled}
            className="reminders-cancel-btn"
          >
            Cancel
          </Button>
        </div>
      </div>
      <div className="reminders-full-row-meta">
        <span className={dueLabelClass}>{formatDueLabel(row, nowMs)}</span>
        {row.media ? (
          <span className="reminders-row-media">· {row.media.title}</span>
        ) : null}
      </div>
      {row.note ? (
        <p className="reminders-full-row-note">{row.note}</p>
      ) : null}
    </div>
  );
}

export function RemindersPageInner() {
  const reminders = useAllActiveReminders();
  const summary = useRemindersSummary();
  const completeReminder = useCompleteReminder();
  const snoozeReminder = useSnoozeReminder();
  const cancelReminder = useCancelReminder();

  const [addOpen, setAddOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<ReminderOverviewRow | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const actionsDisabled =
    completeReminder.isPending || snoozeReminder.isPending || cancelReminder.isPending;

  const nowMs = Date.now();

  const groups = useMemo(
    () => groupByBucket(reminders.data?.items ?? []),
    [reminders.data],
  );

  const summaryText = useMemo(() => {
    if (summary.loading) return null;
    if (!summary.data) return null;
    const parts: string[] = [];
    if (summary.data.totalActive > 0)
      parts.push(`${summary.data.totalActive} active`);
    if (summary.data.overdue > 0)
      parts.push(`${summary.data.overdue} overdue`);
    if (summary.data.dueToday > 0)
      parts.push(`${summary.data.dueToday} due today`);
    return parts.length > 0 ? parts.join(" · ") : null;
  }, [summary.data, summary.loading]);

  const handleSnooze = async (id: string) => {
    setBusyId(id);
    const until = new Date(Date.now() + SNOOZE_DURATION_MS).toISOString();
    try {
      await snoozeReminder.mutateAsync({ id, until });
    } finally {
      setBusyId(current => (current === id ? null : current));
    }
  };

  const handleComplete = async (id: string) => {
    setBusyId(id);
    try {
      await completeReminder.mutateAsync({ id });
    } finally {
      setBusyId(current => (current === id ? null : current));
    }
  };

  const handleCancel = async (id: string) => {
    setBusyId(id);
    try {
      await cancelReminder.mutateAsync({ id });
    } finally {
      setBusyId(current => (current === id ? null : current));
    }
  };

  return (
    <div className="reminders-page">
      <div className="reminders-page-header">
        <div>
          <h1 className="reminders-page-title">Reminders</h1>
          {summaryText ? (
            <p className="reminders-page-summary">{summaryText}</p>
          ) : null}
        </div>
        <Button onClick={() => setAddOpen(true)}>Add reminder</Button>
      </div>

      {reminders.loading ? (
        <div className="reminders-skeleton-list">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="reminders-skeleton-row" />
          ))}
        </div>
      ) : reminders.error ? (
        <p className="reminders-error-text">Failed to load reminders. Please try again.</p>
      ) : groups.length === 0 ? (
        <div className="reminders-empty-state">
          <p className="reminders-empty-text">No active reminders.</p>
          <p className="reminders-empty-subtext">Add one to keep track of important dates.</p>
        </div>
      ) : (
        <div className="reminders-groups">
          {groups.map(({ bucket, rows }) => (
            <div key={bucket} className="reminders-bucket-group">
              <h2 className={`reminders-bucket-heading reminders-bucket-heading--${bucket}`}>
                <span className="reminders-bucket-dot" />
                {BUCKET_LABELS[bucket]}
                <span className="reminders-bucket-count">{rows.length}</span>
              </h2>
              <div className="reminders-bucket-rows">
                {rows.map(row => (
                  <ReminderRow
                    key={row.id}
                    row={row}
                    nowMs={nowMs}
                    busyId={busyId}
                    actionsDisabled={actionsDisabled}
                    completeIsPending={completeReminder.isPending}
                    snoozeIsPending={snoozeReminder.isPending}
                    onEdit={setEditTarget}
                    onSnooze={id => void handleSnooze(id)}
                    onComplete={id => void handleComplete(id)}
                    onCancel={id => void handleCancel(id)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {completeReminder.error || snoozeReminder.error || cancelReminder.error ? (
        <p className="reminders-error-text">
          {completeReminder.error ?? snoozeReminder.error ?? cancelReminder.error}
        </p>
      ) : null}

      <AddReminderDialog open={addOpen} onOpenChange={setAddOpen} />

      {editTarget ? (
        <EditReminderDialog
          open={editTarget !== null}
          onOpenChange={open => {
            if (!open) setEditTarget(null);
          }}
          reminder={editTarget}
        />
      ) : null}
    </div>
  );
}
