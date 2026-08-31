"use client";

import { usePreferences, DEFAULT_PREFERENCES, type Preferences } from "@/hooks/usePreferences";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";

const GENERAL_PREF_KEYS = [
  "autoTagOnIngest",
  "extractMetadata",
  "detectDuplicates",
  "lowMemoryMode",
  "autoUnpackArchives",
  "yellowHighlight",
  "soonWindowDays",
  "ocrMode",
  "ocrTimeoutCapMinutes",
] as const;

function SettingRow({
  id,
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-6 py-3 border-b border-border last:border-0">
      <div className="space-y-0.5">
        <label htmlFor={id} className="text-sm font-medium cursor-pointer">
          {label}
        </label>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={e => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 rounded border border-border bg-card text-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      />
    </div>
  );
}

export function GeneralSettingsCard() {
  const { prefs, updatePreferences, isLoaded } = usePreferences();

  const handleReset = () => {
    const patch = Object.fromEntries(
      GENERAL_PREF_KEYS.map(k => [k, DEFAULT_PREFERENCES[k]])
    ) as Pick<typeof DEFAULT_PREFERENCES, typeof GENERAL_PREF_KEYS[number]>;
    updatePreferences(patch);
    window.dispatchEvent(new CustomEvent('vault:split-reset', { detail: { storageKey: 'vault.sidebar.tagsSplitRatio.v2' } }));
  };

  return (
    <Card className="h-full">
      <CardHeader className="flex flex-row items-start justify-between gap-4 pb-4">
        <div>
          <CardTitle>General Settings</CardTitle>
          <CardDescription className="mt-1">Uploads, metadata, and display defaults.</CardDescription>
        </div>
        <Button variant="outline" size="sm" disabled={!isLoaded} onClick={handleReset}>
          Reset to defaults
        </Button>
      </CardHeader>
      <CardContent className="px-6 pb-6 pt-2">
        <SettingRow
          id="auto-tag-on-ingest"
          label="Auto-tag files as they're added"
          description="Apply your Tag Organizer rules to files when they're uploaded, indexed, or unpacked from an archive."
          checked={prefs.autoTagOnIngest}
          disabled={!isLoaded}
          onChange={v => updatePreferences({ autoTagOnIngest: v })}
        />
        <SettingRow
          id="extract-exif"
          label="Extract photo camera metadata (EXIF)"
          description="Keep camera metadata attached to uploads."
          checked={prefs.extractMetadata}
          disabled={!isLoaded}
          onChange={v => updatePreferences({ extractMetadata: v })}
        />
        <SettingRow
          id="detect-duplicates"
          label="Detect exact duplicates"
          description="Scan uploads using hash comparison."
          checked={prefs.detectDuplicates}
          disabled={!isLoaded}
          onChange={v => updatePreferences({ detectDuplicates: v })}
        />
        <SettingRow
          id="low-memory-mode"
          label="Low memory mode"
          description="Halves thumbnail and text processing concurrency. Takes effect after docker restart."
          checked={prefs.lowMemoryMode}
          disabled={!isLoaded}
          onChange={v => updatePreferences({ lowMemoryMode: v })}
        />
        <SettingRow
          id="auto-unpack-archives"
          label="Auto-unpack archives on upload"
          description="Automatically extract ZIP and TAR archives into bundles when uploaded."
          checked={prefs.autoUnpackArchives}
          disabled={!isLoaded}
          onChange={v => updatePreferences({ autoUnpackArchives: v })}
        />
        <SettingRow
          id="yellow-highlight"
          label="Yellow search highlights"
          description="Use classic yellow highlights instead of the theme color."
          checked={prefs.yellowHighlight}
          disabled={!isLoaded}
          onChange={v => updatePreferences({ yellowHighlight: v })}
        />
        <div className="flex items-start justify-between gap-6 py-3">
          <div className="space-y-0.5">
            <label htmlFor="soon-window-days" className="text-sm font-medium">
              &quot;Due soon&quot; window
            </label>
            <p className="text-xs text-muted-foreground">
              Reminders due within this many days show as &quot;Due soon&quot;.
            </p>
          </div>
          <div className={`flex items-center gap-2 shrink-0 transition-opacity ${!isLoaded ? "opacity-50 pointer-events-none" : ""}`}>
            <input
              id="soon-window-days"
              type="range"
              min={2}
              max={14}
              step={1}
              value={prefs.soonWindowDays}
              disabled={!isLoaded}
              onChange={e => updatePreferences({ soonWindowDays: Number(e.target.value) })}
              className="w-28 accent-primary"
            />
            <span className="text-sm font-medium w-12 text-right">{prefs.soonWindowDays}d</span>
          </div>
        </div>
        <div className="flex items-start justify-between gap-6 py-3">
          <div className="space-y-0.5">
            <label htmlFor="ocr-mode" className="text-sm font-medium">
              Text extraction for scans
            </label>
            <p className="text-xs text-muted-foreground">
              Documents that already contain text are always read at index time. This
              controls the slow path — running OCR on scans and photos, which can take
              hours on a large library.
            </p>
          </div>
          <div className={`shrink-0 transition-opacity ${!isLoaded ? "opacity-50 pointer-events-none" : ""}`}>
            <select
              id="ocr-mode"
              value={prefs.ocrMode}
              disabled={!isLoaded}
              onChange={e => updatePreferences({ ocrMode: e.target.value as Preferences["ocrMode"] })}
              className="rounded-md border border-input bg-background px-2 py-1 text-sm"
            >
              <option value="onDemand">When I open the file</option>
              <option value="background">Continuously in the background</option>
              <option value="off">Never</option>
            </select>
          </div>
        </div>
        <div className="flex items-start justify-between gap-6 py-3">
          <div className="space-y-0.5">
            <label htmlFor="ocr-timeout-cap" className="text-sm font-medium">
              OCR time limit per file
            </label>
            <p className="text-xs text-muted-foreground">
              Stops a stuck or oversized scan from occupying a worker slot past this
              limit.
            </p>
          </div>
          <div className={`flex items-center gap-2 shrink-0 transition-opacity ${!isLoaded ? "opacity-50 pointer-events-none" : ""}`}>
            <input
              id="ocr-timeout-cap"
              type="range"
              min={1}
              max={60}
              step={1}
              value={prefs.ocrTimeoutCapMinutes}
              disabled={!isLoaded}
              onChange={e => updatePreferences({ ocrTimeoutCapMinutes: Number(e.target.value) })}
              className="w-28 accent-primary"
            />
            <span className="text-sm font-medium w-12 text-right">{prefs.ocrTimeoutCapMinutes}m</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
