"use client";

import React, { useEffect, useMemo, useState } from "react";
import { usePreferences, DEFAULT_PREFERENCES, type LightTheme, type DarkTheme } from "@/hooks/usePreferences";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { emitTagsUpdated, TAGS_UPDATED_EVENT } from "@/lib/tags";
import { ConfirmPopover } from "@/components/ui/ConfirmPopover";

type TagRow = { name: string; count: number };

const MAX_FETCH = 50;
const INITIAL_VISIBLE = 20;

// ─── Appearance ───────────────────────────────────────────────────────────────

type LightThemeOption = { id: LightTheme; label: string; bg: string; card: string; borderColor: string; textColor: string };
type DarkThemeOption  = { id: DarkTheme;  label: string; bg: string; card: string; borderColor: string; textColor: string };

const LIGHT_THEMES: LightThemeOption[] = [
  { id: "default",      label: "Default",      bg: "hsl(240,5%,93%)",   card: "hsl(240,5%,99%)",   borderColor: "hsl(240,5.9%,90%)",  textColor: "hsl(0,0%,3.9%)"   },
  { id: "latte",        label: "Latte",        bg: "hsl(36,38%,86%)",   card: "hsl(36,60%,95%)",   borderColor: "hsl(36,24%,80%)",    textColor: "hsl(0,0%,3.9%)"   },
  { id: "solarize",     label: "Solarize",     bg: "hsl(28,50%,76%)",   card: "hsl(28,55%,82%)",   borderColor: "hsl(28,36%,67%)",    textColor: "hsl(0,0%,3.9%)"   },
  { id: "mist",         label: "Mist",         bg: "hsl(202,22%,87%)",  card: "hsl(202,28%,94%)",  borderColor: "hsl(202,16%,83%)",   textColor: "hsl(0,0%,3.9%)"   },
  { id: "lavender",     label: "Lavender",     bg: "hsl(263,22%,87%)",  card: "hsl(263,28%,94%)",  borderColor: "hsl(263,16%,83%)",   textColor: "hsl(0,0%,3.9%)"   },
  { id: "dream",        label: "Dream",        bg: "hsl(335,28%,88%)",  card: "hsl(335,34%,95%)",  borderColor: "hsl(335,18%,84%)",   textColor: "hsl(0,0%,3.9%)"   },
  { id: "cotton-candy", label: "Cotton Candy", bg: "hsl(335,55%,82%)",  card: "hsl(200,72%,88%)",  borderColor: "hsl(330,100%,60%)",  textColor: "hsl(0,0%,3.9%)"   },
  { id: "mint",         label: "Mint",         bg: "hsl(148,20%,83%)",  card: "hsl(145,26%,92%)",  borderColor: "hsl(148,16%,77%)",   textColor: "hsl(0,0%,3.9%)"   },
  { id: "garden",       label: "Garden",       bg: "hsl(130,26%,55%)",  card: "hsl(137,32%,72%)",  borderColor: "hsl(130,26%,46%)",   textColor: "hsl(0,0%,3.9%)"   },
];

const DARK_THEMES: DarkThemeOption[] = [
  { id: "new-moon", label: "New Moon", bg: "hsl(220,28%,6%)",  card: "hsl(221,39%,11%)",  borderColor: "hsl(215,20%,18%)",  textColor: "hsl(0,0%,98%)"    },
  { id: "charcoal", label: "Charcoal", bg: "hsl(220,5%,13%)",  card: "hsl(220,5%,20%)",   borderColor: "hsl(220,5%,26%)",   textColor: "hsl(0,0%,88%)"    },
  { id: "matrix",   label: "Matrix",   bg: "hsl(0,0%,2%)",     card: "hsl(120,8%,7%)",    borderColor: "hsl(120,10%,14%)",  textColor: "hsl(120,80%,60%)" },
];

function ThemeSwatch<T extends string>({
  theme,
  selected,
  onSelect,
}: {
  theme: { id: T; label: string; bg: string; card: string; borderColor: string; textColor: string };
  selected: boolean;
  onSelect: (id: T) => void;
}) {
  return (
    <button
      onClick={() => onSelect(theme.id)}
      className={`flex flex-col items-center gap-1.5 rounded-lg p-2 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${selected ? "ring-2 ring-primary" : ""}`}
      aria-pressed={selected}
    >
      <div
        className="h-10 w-16 rounded-md border flex items-center justify-center"
        style={{ backgroundColor: theme.bg, borderColor: theme.borderColor }}
      >
        <div
          className="h-5 w-8 rounded shadow-sm border"
          style={{ backgroundColor: theme.card, borderColor: theme.textColor }}
        />
      </div>
      <span className="text-[11px] font-medium text-muted-foreground leading-none">
        {theme.label}
      </span>
    </button>
  );
}

function AppearanceCard() {
  const { prefs, updatePreferences, isLoaded } = usePreferences();

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>Appearance</CardTitle>
        <CardDescription>Color schemes for light and dark mode.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Light</p>
          <div className={`flex flex-wrap gap-1 transition-opacity ${!isLoaded ? "opacity-50 pointer-events-none" : ""}`}>
            {LIGHT_THEMES.map(t => (
              <ThemeSwatch
                key={t.id}
                theme={t}
                selected={prefs.lightTheme === t.id}
                onSelect={(id) => updatePreferences({ lightTheme: id })}
              />
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Dark</p>
          <div className={`flex flex-wrap gap-1 transition-opacity ${!isLoaded ? "opacity-50 pointer-events-none" : ""}`}>
            {DARK_THEMES.map(t => (
              <ThemeSwatch
                key={t.id}
                theme={t}
                selected={prefs.darkTheme === t.id}
                onSelect={(id) => updatePreferences({ darkTheme: id })}
              />
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── General Settings ─────────────────────────────────────────────────────────

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

const GENERAL_PREF_KEYS = [
  "autoTagOnUpload",
  "extractMetadata",
  "detectDuplicates",
  "collapseMetadataByDefault",
  "lowMemoryMode",
  "soonWindowDays",
] as const;

function GeneralSettingsCard() {
  const { prefs, updatePreferences, isLoaded } = usePreferences();

  const handleReset = () => {
    const patch = Object.fromEntries(
      GENERAL_PREF_KEYS.map(k => [k, DEFAULT_PREFERENCES[k]])
    ) as Pick<typeof DEFAULT_PREFERENCES, typeof GENERAL_PREF_KEYS[number]>;
    updatePreferences(patch);
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
          id="auto-tag-on-upload"
          label="Auto-tag files on upload"
          description="Automatically apply tags to newly uploaded media."
          checked={prefs.autoTagOnUpload}
          disabled={!isLoaded}
          onChange={v => updatePreferences({ autoTagOnUpload: v })}
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
          id="collapse-metadata-default"
          label="Collapse metadata by default"
          description="Close metadata panels when media details open."
          checked={prefs.collapseMetadataByDefault}
          disabled={!isLoaded}
          onChange={v => updatePreferences({ collapseMetadataByDefault: v })}
        />
        <SettingRow
          id="low-memory-mode"
          label="Low memory mode"
          description="Halves thumbnail and text processing concurrency. Takes effect after docker restart."
          checked={prefs.lowMemoryMode}
          disabled={!isLoaded}
          onChange={v => updatePreferences({ lowMemoryMode: v })}
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
      </CardContent>
    </Card>
  );
}

// ─── Manage Tags ──────────────────────────────────────────────────────────────

function ManageTagsCard() {
  const [tags, setTags] = useState<TagRow[]>([]);
  const [visible, setVisible] = useState(INITIAL_VISIBLE);
  const [isLoading, setIsLoading] = useState(true);
  const [isDeleting, setIsDeleting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmState, setConfirmState] = useState<{ x: number; y: number; name: string } | null>(null);
  const [deleteEmptyStatus, setDeleteEmptyStatus] = useState<"success" | "none" | null>(null);

  const load = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/tags?limit=${MAX_FETCH}`, { credentials: "include" });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setError(data?.message || data?.error || "Unable to load tags.");
        return;
      }
      const data = (await res.json()) as { tags?: TagRow[] };
      setTags(data.tags ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load tags.");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void load();
    const handler = () => void load();
    window.addEventListener(TAGS_UPDATED_EVENT, handler);
    return () => window.removeEventListener(TAGS_UPDATED_EVENT, handler);
  }, []);

  const visibleTags = useMemo(() => tags.slice(0, visible), [tags, visible]);
  const canShowMore = visible < Math.min(tags.length, MAX_FETCH);

  const requestDelete = (name: string, e: React.MouseEvent) => {
    if (isDeleting) return;
    setConfirmState({ x: e.clientX, y: e.clientY, name });
  };

  const handleDelete = async (name: string) => {
    setIsDeleting(name);
    setError(null);
    try {
      const res = await fetch(`/api/tags/${encodeURIComponent(name)}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setError(data?.message || data?.error || "Unable to delete tag.");
        return;
      }
      setTags(prev => prev.filter(t => t.name !== name));
      emitTagsUpdated({ deletedTag: name });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to delete tag.");
    } finally {
      setIsDeleting(null);
    }
  };

  const handleDeleteEmptyTags = () => {
    const emptyTags = tags.filter(t => t.count === 0);
    if (emptyTags.length === 0) {
      setDeleteEmptyStatus("none");
    } else {
      // TODO: call the backend to remove empty tags when the endpoint exists.
      setDeleteEmptyStatus("success");
    }
    setTimeout(() => setDeleteEmptyStatus(null), 3000);
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 pb-4">
        <div>
          <CardTitle>Manage Tags</CardTitle>
          <CardDescription className="mt-1">View and delete tags across your library.</CardDescription>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <Button variant="destructive" size="sm" onClick={handleDeleteEmptyTags}>
            Delete empty tags
          </Button>
          {deleteEmptyStatus && (
            <p className="text-xs text-muted-foreground">
              {deleteEmptyStatus === "success" ? "Empty tags deleted." : "No empty tags to delete."}
            </p>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {error && <div className="mb-3 text-sm text-destructive">{error}</div>}
        {isLoading ? (
          <div className="text-sm text-muted-foreground">Loading tags...</div>
        ) : visibleTags.length === 0 ? (
          <div className="text-sm text-muted-foreground">No tags yet.</div>
        ) : (
          <div className="space-y-2">
            {visibleTags.map(tag => (
              <div
                key={tag.name}
                className="flex items-center justify-between rounded-md border px-3 py-2 text-sm"
              >
                <div className="flex items-center gap-3">
                  <span className="font-medium">{tag.name}</span>
                  <span className="text-xs text-muted-foreground">{tag.count} items</span>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={(e) => requestDelete(tag.name, e)}
                  disabled={isDeleting === tag.name}
                >
                  {isDeleting === tag.name ? "Deleting..." : "Delete"}
                </Button>
              </div>
            ))}
            {canShowMore && (
              <Button variant="outline" size="sm" onClick={() => setVisible(v => v + 10)}>
                Show more
              </Button>
            )}
          </div>
        )}
      </CardContent>
      <ConfirmPopover
        open={confirmState !== null}
        x={confirmState?.x ?? 0}
        y={confirmState?.y ?? 0}
        message={`Delete tag "${confirmState?.name}"? This will remove it from all media.`}
        onConfirm={() => { const name = confirmState!.name; setConfirmState(null); void handleDelete(name); }}
        onCancel={() => setConfirmState(null)}
      />
    </Card>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function SettingsPage() {
  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      <div>
        <h1 className="text-2xl font-semibold mb-1">Settings</h1>
        <p className="text-sm text-muted-foreground">Configure your account and app preferences.</p>
      </div>

      {/* Primary row: General Settings + Appearance side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">
          <GeneralSettingsCard />
        </div>
        <div className="lg:col-span-1">
          <AppearanceCard />
        </div>
      </div>

      {/* Secondary row: Tag management, constrained width */}
      <div className="max-w-2xl">
        <ManageTagsCard />
      </div>
    </div>
  );
}
