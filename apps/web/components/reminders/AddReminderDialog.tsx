"use client";

import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Label } from "@/components/ui/Label";
import { Sheet, SheetContent } from "@/components/ui/Sheet";
import { toast } from "@/components/ui/Toaster";
import { useCreateReminder } from "@/lib/reminders";

type AddReminderDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: () => void;
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

function getNowLocalMin() {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

export function AddReminderDialog({ open, onOpenChange, onCreated }: AddReminderDialogProps) {
  const createReminder = useCreateReminder();
  const [title, setTitle] = useState("");
  const [minDateTime, setMinDateTime] = useState(getNowLocalMin);
  const [note, setNote] = useState("");
  const [dueAtLocal, setDueAtLocal] = useState("");
  const [dueMeridiem, setDueMeridiem] = useState<"AM" | "PM">("AM");
  const [remindOffsetDays, setRemindOffsetDays] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (open) setMinDateTime(getNowLocalMin());
  }, [open]);

  const resetForm = () => {
    setTitle("");
    setNote("");
    setDueAtLocal("");
    setDueMeridiem("AM");
    setRemindOffsetDays("");
    setFormError(null);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && !createReminder.isPending) {
      resetForm();
    }
    onOpenChange(nextOpen);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (createReminder.isPending) return;

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
    if (new Date(dueAt).getTime() <= Date.now()) {
      setFormError("Due date/time must be in the future.");
      return;
    }

    let parsedOffset: number | undefined;
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

    const trimmedNote = note.trim();

    try {
      await createReminder.mutateAsync({
        title: trimmedTitle,
        ...(trimmedNote.length > 0 ? { note: trimmedNote } : {}),
        dueAt,
        ...(parsedOffset !== undefined ? { remindOffsetDays: parsedOffset } : {}),
      });
      toast("Reminder added", { variant: "success" });
      resetForm();
      onOpenChange(false);
      onCreated?.();
    } catch {
      // Hook error state provides user-facing message.
    }
  };

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent side="right" className="reminder-dialog-content">
        <div className="reminder-dialog-body">
          <div>
            <h3 className="reminder-dialog-title">Add reminder</h3>
            <p className="reminder-dialog-subtitle">Create a quick reminder</p>
          </div>

          <form className="reminder-dialog-form" onSubmit={handleSubmit}>
            <div className="reminder-form-group">
              <Label htmlFor="reminder-title">Reminder</Label>
              <Input
                id="reminder-title"
                value={title}
                onChange={event => setTitle(event.target.value)}
                placeholder="Renew insurance"
                required
                disabled={createReminder.isPending}
              />
            </div>

            <div className="reminder-form-group">
              <Label htmlFor="reminder-note">Note (optional)</Label>
              <textarea
                id="reminder-note"
                value={note}
                onChange={event => setNote(event.target.value)}
                placeholder="Add a note..."
                maxLength={5000}
                rows={3}
                disabled={createReminder.isPending}
                className="reminder-note-input"
                aria-label="Note"
              />
            </div>

            <div className="reminder-form-group">
              <Label htmlFor="reminder-due">Due date/time</Label>
              <div id="reminder-due" className="reminder-due-grid">
                <Input
                  id="reminder-due"
                  type="datetime-local"
                  value={dueAtLocal}
                  min={minDateTime}
                  onChange={event => {
                    const nextValue = event.target.value;
                    setDueAtLocal(nextValue);
                    setDueMeridiem(inferMeridiem(nextValue));
                  }}
                  disabled={createReminder.isPending}
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
                  disabled={createReminder.isPending}
                  className="reminder-meridiem-select"
                  aria-label="Due meridiem"
                >
                  <option value="AM">AM</option>
                  <option value="PM">PM</option>
                </select>
              </div>
            </div>

            <div className="reminder-form-group">
              <Label htmlFor="reminder-offset">Remind X days before (optional)</Label>
              <Input
                id="reminder-offset"
                type="number"
                min={0}
                step={1}
                inputMode="numeric"
                placeholder="Leave empty for default"
                value={remindOffsetDays}
                onChange={event => setRemindOffsetDays(event.target.value)}
                disabled={createReminder.isPending}
              />
            </div>

            {formError || createReminder.error ? (
              <p className="reminder-form-error">{formError ?? createReminder.error}</p>
            ) : null}

            <div className="reminder-form-actions">
              <Button
                type="button"
                variant="outline"
                onClick={() => handleOpenChange(false)}
                disabled={createReminder.isPending}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={createReminder.isPending}>
                {createReminder.isPending ? "Adding..." : "Add reminder"}
              </Button>
            </div>
          </form>
        </div>
      </SheetContent>
    </Sheet>
  );
}
