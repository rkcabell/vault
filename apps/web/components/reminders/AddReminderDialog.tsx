"use client";

import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Label } from "@/components/ui/Label";
import { Dialog, DialogContent } from "@/components/ui/Dialog";
import { toast } from "@/components/ui/Toaster";
import { useCreateReminder } from "@/lib/reminders";
import { MediaPicker, type MediaPickerItem } from "@/components/reminders/MediaPicker";

type AddReminderDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: () => void;
  initialMediaId?: string | null;
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
  return `${datePart}T${String(nextHour24).padStart(2, "0")}:${minute}`;
}

function inferMeridiem(localValue: string): "AM" | "PM" {
  const match = /^\d{4}-\d{2}-\d{2}T(\d{2}):\d{2}$/.exec(localValue);
  if (!match) return "AM";
  return Number.parseInt(match[1], 10) >= 12 ? "PM" : "AM";
}

function getNowLocalMin() {
  const now = new Date(Date.now() + 60_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

type RRuleFreq = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
const FREQ_LABELS: Record<RRuleFreq, string> = { DAILY: "Daily", WEEKLY: "Weekly", MONTHLY: "Monthly", YEARLY: "Yearly" };
const FREQ_UNITS: Record<RRuleFreq, string> = { DAILY: "day(s)", WEEKLY: "week(s)", MONTHLY: "month(s)", YEARLY: "year(s)" };

function buildRRule(freq: string, intervalStr: string, untilDate: string): string | null {
  if (!freq) return null;
  const parts = [`FREQ=${freq}`];
  const interval = Number.parseInt(intervalStr, 10);
  if (Number.isInteger(interval) && interval > 1) parts.push(`INTERVAL=${interval}`);
  if (untilDate) parts.push(`UNTIL=${untilDate}`);
  return parts.join(";");
}

const selectClass =
  "h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

export function AddReminderDialog({ open, onOpenChange, onCreated, initialMediaId }: AddReminderDialogProps) {
  const createReminder = useCreateReminder();
  const [title, setTitle] = useState("");
  const [minDateTime, setMinDateTime] = useState(getNowLocalMin);
  const [note, setNote] = useState("");
  const [dueAtLocal, setDueAtLocal] = useState("");
  const [dueMeridiem, setDueMeridiem] = useState<"AM" | "PM">("AM");
  const [remindOffsetDays, setRemindOffsetDays] = useState("");
  const [rruleFreq, setRruleFreq] = useState("");
  const [rruleInterval, setRruleInterval] = useState("1");
  const [rruleUntil, setRruleUntil] = useState("");
  const [selectedMedia, setSelectedMedia] = useState<MediaPickerItem | null>(null);
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
    setRruleFreq("");
    setRruleInterval("1");
    setRruleUntil("");
    setSelectedMedia(null);
    setFormError(null);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && !createReminder.isPending) resetForm();
    onOpenChange(nextOpen);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (createReminder.isPending) return;

    const trimmedTitle = title.trim();
    if (!trimmedTitle) { setFormError("Title is required."); return; }

    const dueAt = localDateTimeToIso(withMeridiem(dueAtLocal, dueMeridiem));
    if (!dueAt) { setFormError("Please provide a valid due date and time."); return; }
    if (new Date(dueAt).getTime() <= Date.now()) { setFormError("Due date/time must be in the future."); return; }

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
    const rrule = buildRRule(rruleFreq, rruleInterval, rruleUntil);

    try {
      await createReminder.mutateAsync({
        title: trimmedTitle,
        ...(note.trim() ? { note: note.trim() } : {}),
        dueAt,
        ...(parsedOffset !== undefined ? { remindOffsetDays: parsedOffset } : {}),
        ...(rrule ? { rrule } : {}),
        ...(selectedMedia ? { mediaId: selectedMedia.id } : initialMediaId ? { mediaId: initialMediaId } : {}),
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
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-xl w-full max-h-[90vh] overflow-y-auto vault-scrollbar">
        <h2 className="text-2xl font-bold tracking-tight mb-1">Add reminder</h2>
        <p className="text-sm text-muted-foreground mb-6">Set a due date and optionally link it to an item in your vault.</p>

        <form className="space-y-5" onSubmit={handleSubmit}>
          <div className="space-y-2">
            <Label htmlFor="reminder-title">Reminder</Label>
            <Input
              id="reminder-title"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="Renew insurance"
              required
              disabled={createReminder.isPending}
              autoFocus
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="reminder-note">
              Note <span className="text-muted-foreground font-normal">(optional)</span>
            </Label>
            <textarea
              id="reminder-note"
              value={note}
              onChange={e => setNote(e.target.value)}
              placeholder="Add a note..."
              maxLength={5000}
              rows={3}
              disabled={createReminder.isPending}
              className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 resize-none"
            />
          </div>

          <div className="space-y-2">
            <Label>
              Linked item <span className="text-muted-foreground font-normal">(optional)</span>
            </Label>
            <MediaPicker
              value={selectedMedia}
              onChange={setSelectedMedia}
              disabled={createReminder.isPending}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="reminder-due">Due date/time</Label>
            <div className="grid grid-cols-12 gap-2">
              <Input
                id="reminder-due"
                type="datetime-local"
                value={dueAtLocal}
                min={minDateTime}
                onChange={e => {
                  setDueAtLocal(e.target.value);
                  setDueMeridiem(inferMeridiem(e.target.value));
                }}
                disabled={createReminder.isPending}
                className="col-span-9"
                aria-label="Due date and time"
              />
              <select
                value={dueMeridiem}
                onChange={e => {
                  const m = e.target.value === "PM" ? "PM" : "AM";
                  setDueMeridiem(m);
                  setDueAtLocal(cur => withMeridiem(cur, m));
                }}
                disabled={createReminder.isPending}
                className={`col-span-3 ${selectClass}`}
                aria-label="AM or PM"
              >
                <option value="AM">AM</option>
                <option value="PM">PM</option>
              </select>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="reminder-offset">
              Remind X days before <span className="text-muted-foreground font-normal">(optional)</span>
            </Label>
            <Input
              id="reminder-offset"
              type="number"
              min={0}
              max={3650}
              step={1}
              inputMode="numeric"
              placeholder="Leave empty for none"
              value={remindOffsetDays}
              onChange={e => setRemindOffsetDays(e.target.value)}
              onKeyDown={e => { if (["e", "E", "-", "+"].includes(e.key)) e.preventDefault(); }}
              disabled={createReminder.isPending}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="reminder-rrule-freq">
              Repeats <span className="text-muted-foreground font-normal">(optional)</span>
            </Label>
            <select
              id="reminder-rrule-freq"
              value={rruleFreq}
              onChange={e => { setRruleFreq(e.target.value); if (!e.target.value) setRruleInterval("1"); }}
              disabled={createReminder.isPending}
              className={selectClass}
              aria-label="Repeat frequency"
            >
              <option value="">None</option>
              {(Object.keys(FREQ_LABELS) as RRuleFreq[]).map(f => (
                <option key={f} value={f}>{FREQ_LABELS[f]}</option>
              ))}
            </select>
            {rruleFreq && (
              <div className="space-y-2 pt-1">
                <p className="text-sm text-muted-foreground">for</p>
                <div className="grid grid-cols-12 gap-2">
                  <Input
                    type="number" min={1} max={999} step={1} inputMode="numeric"
                    aria-label="Repeat interval"
                    value={rruleInterval}
                    onChange={e => setRruleInterval(e.target.value)}
                    onKeyDown={e => { if (["e", "E", "-", "+", "."].includes(e.key)) e.preventDefault(); }}
                    disabled={createReminder.isPending}
                    className="col-span-9"
                  />
                  <span className="col-span-3 flex items-center text-sm text-muted-foreground">
                    {FREQ_UNITS[rruleFreq as RRuleFreq]}
                  </span>
                </div>
                <p className="text-sm text-muted-foreground">or until</p>
                <Input
                  type="date"
                  aria-label="Repeat until date"
                  value={rruleUntil}
                  onChange={e => setRruleUntil(e.target.value)}
                  disabled={createReminder.isPending}
                />
              </div>
            )}
          </div>

          {(formError ?? createReminder.error) && (
            <p className="text-sm text-destructive">{formError ?? createReminder.error}</p>
          )}

          <div className="flex items-center gap-3 pt-1">
            <Button type="submit" disabled={createReminder.isPending}>
              {createReminder.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {createReminder.isPending ? "Adding..." : "Add reminder"}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={createReminder.isPending}
            >
              Cancel
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
