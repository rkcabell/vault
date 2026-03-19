"use client";

import { useState, useEffect } from "react";
import type { FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Label } from "@/components/ui/Label";
import { Sheet, SheetContent } from "@/components/ui/Sheet";
import { toast } from "@/components/ui/Toaster";
import { useUpdateReminder, type ReminderOverviewRow } from "@/lib/reminders";

type EditReminderDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  reminder: ReminderOverviewRow;
  onUpdated?: () => void;
};

function localDateTimeToIso(localValue: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(localValue);
  if (!match) return null;

  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  const hour = Number.parseInt(match[4], 10);
  const minute = Number.parseInt(match[5], 10);

  const localDate = new Date(year, month - 1, day, hour, minute, 0, 0);
  if (Number.isNaN(localDate.getTime())) return null;
  return localDate.toISOString();
}

function withMeridiem(localValue: string, meridiem: "AM" | "PM") {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(localValue);
  if (!match) return localValue;

  const datePart = match[1];
  const minute = match[3];
  const existingHour24 = Number.parseInt(match[2], 10);
  const hour12 = existingHour24 % 12;
  const nextHour24 = hour12 + (meridiem === "PM" ? 12 : 0);
  const hourText = String(nextHour24).padStart(2, "0");

  return `${datePart}T${hourText}:${minute}`;
}

function inferMeridiem(localValue: string): "AM" | "PM" {
  const match = /^\d{4}-\d{2}-\d{2}T(\d{2}):\d{2}$/.exec(localValue);
  if (!match) return "AM";
  const hour24 = Number.parseInt(match[1], 10);
  return hour24 >= 12 ? "PM" : "AM";
}

function isoToLocalDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hour = String(d.getHours()).padStart(2, "0");
  const minute = String(d.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}T${hour}:${minute}`;
}

export function EditReminderDialog({ open, onOpenChange, reminder, onUpdated }: EditReminderDialogProps) {
  const updateReminder = useUpdateReminder();
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [dueAtLocal, setDueAtLocal] = useState("");
  const [dueMeridiem, setDueMeridiem] = useState<"AM" | "PM">("AM");
  const [remindOffsetDays, setRemindOffsetDays] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  // Populate form when reminder changes or dialog opens
  useEffect(() => {
    if (!open) return;
    const localDue = isoToLocalDateTime(reminder.effectiveDueAt);
    setTitle(reminder.title);
    setNote(reminder.note ?? "");
    setDueAtLocal(localDue);
    setDueMeridiem(inferMeridiem(localDue));
    setRemindOffsetDays(
      reminder.remindOffsetDays !== null ? String(reminder.remindOffsetDays) : "",
    );
    setFormError(null);
  }, [open, reminder]);

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && !updateReminder.isPending) {
      setFormError(null);
    }
    onOpenChange(nextOpen);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (updateReminder.isPending) return;

    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setFormError("Title is required.");
      return;
    }

    const dueAt = localDateTimeToIso(withMeridiem(dueAtLocal, dueMeridiem));
    if (!dueAt) {
      setFormError("Please provide a valid due date and time.");
      return;
    }

    let parsedOffset: number | null = null;
    const offsetText = remindOffsetDays.trim();
    if (offsetText.length > 0) {
      const maybeOffset = Number.parseInt(offsetText, 10);
      if (!Number.isInteger(maybeOffset) || maybeOffset < 0) {
        setFormError("Remind offset must be a whole number 0 or greater.");
        return;
      }
      parsedOffset = maybeOffset;
    }

    setFormError(null);

    try {
      await updateReminder.mutateAsync({
        id: reminder.id,
        title: trimmedTitle,
        note: note.trim() || null,
        dueAt,
        remindOffsetDays: parsedOffset,
      });
      toast("Reminder updated", { variant: "success" });
      onOpenChange(false);
      onUpdated?.();
    } catch {
      // Hook error state provides user-facing message.
    }
  };

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent side="right" className="reminder-dialog-content">
        <div className="reminder-dialog-body">
          <div>
            <h3 className="reminder-dialog-title">Edit reminder</h3>
            <p className="reminder-dialog-subtitle">Update reminder details</p>
          </div>

          <form className="reminder-dialog-form" onSubmit={handleSubmit}>
            <div className="reminder-form-group">
              <Label htmlFor="edit-reminder-title">Reminder</Label>
              <Input
                id="edit-reminder-title"
                value={title}
                onChange={event => setTitle(event.target.value)}
                placeholder="Renew insurance"
                required
                disabled={updateReminder.isPending}
              />
            </div>

            <div className="reminder-form-group">
              <Label htmlFor="edit-reminder-note">Note (optional)</Label>
              <textarea
                id="edit-reminder-note"
                value={note}
                onChange={event => setNote(event.target.value)}
                placeholder="Add a note..."
                maxLength={5000}
                rows={3}
                disabled={updateReminder.isPending}
                className="reminder-note-input"
                aria-label="Note"
              />
            </div>

            <div className="reminder-form-group">
              <Label htmlFor="edit-reminder-due">Due date/time</Label>
              <div id="edit-reminder-due" className="reminder-due-grid">
                <Input
                  id="edit-reminder-due-input"
                  type="datetime-local"
                  value={dueAtLocal}
                  onChange={event => {
                    const nextValue = event.target.value;
                    setDueAtLocal(nextValue);
                    setDueMeridiem(inferMeridiem(nextValue));
                  }}
                  disabled={updateReminder.isPending}
                  className="reminder-due-input"
                  aria-label="Due date and time"
                />
                <select
                  value={dueMeridiem}
                  onChange={event => {
                    const nextMeridiem = event.target.value === "PM" ? "PM" : "AM";
                    setDueMeridiem(nextMeridiem);
                    setDueAtLocal(current => withMeridiem(current, nextMeridiem));
                  }}
                  disabled={updateReminder.isPending}
                  className="reminder-meridiem-select"
                  aria-label="Due meridiem"
                >
                  <option value="AM">AM</option>
                  <option value="PM">PM</option>
                </select>
              </div>
            </div>

            <div className="reminder-form-group">
              <Label htmlFor="edit-reminder-offset">Remind X days before (optional)</Label>
              <Input
                id="edit-reminder-offset"
                type="number"
                min={0}
                max={3650}
                step={1}
                inputMode="numeric"
                placeholder="Leave empty for default"
                value={remindOffsetDays}
                onChange={event => setRemindOffsetDays(event.target.value)}
                onKeyDown={e => { if (['e', 'E', '-', '+'].includes(e.key)) e.preventDefault(); }}
                disabled={updateReminder.isPending}
              />
            </div>

            {formError || updateReminder.error ? (
              <p className="reminder-form-error">{formError ?? updateReminder.error}</p>
            ) : null}

            <div className="reminder-form-actions">
              <Button
                type="button"
                variant="outline"
                onClick={() => handleOpenChange(false)}
                disabled={updateReminder.isPending}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={updateReminder.isPending}>
                {updateReminder.isPending ? "Saving..." : "Save changes"}
              </Button>
            </div>
          </form>
        </div>
      </SheetContent>
    </Sheet>
  );
}
