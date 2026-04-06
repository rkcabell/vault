"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { usePreferences, DEFAULT_PREFERENCES, type LightTheme, type DarkTheme } from "@/hooks/usePreferences";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { emitTagsUpdated, TAGS_UPDATED_EVENT } from "@/lib/tags";
import { ConfirmPopover } from "@/components/ui/ConfirmPopover";

type TagRow = { name: string; count: number; color: string | null };

// 12 standard colors — 2 rows × 6
const TAG_SWATCHES = [
  "#ef4444", // Red
  "#f97316", // Orange
  "#eab308", // Yellow
  "#22c55e", // Green
  "#14b8a6", // Teal
  "#3b82f6", // Blue
  "#6366f1", // Indigo
  "#a855f7", // Purple
  "#ec4899", // Pink
  "#f43f5e", // Rose
  "#78716c", // Brown
  "#6b7280", // Gray
];

const MAX_FETCH = 50;
const INITIAL_VISIBLE = 20;

// ─── Appearance ───────────────────────────────────────────────────────────────

type LightThemeOption = { id: LightTheme; label: string; bg: string; card: string; borderColor: string; textColor: string };
type DarkThemeOption  = { id: DarkTheme;  label: string; bg: string; card: string; borderColor: string; textColor: string };

const LIGHT_THEMES: LightThemeOption[] = [
  { id: "default",      label: "Default",      bg: "hsl(240,5%,93%)",   card: "hsl(240,5%,99%)",   borderColor: "hsl(240,5.9%,90%)",  textColor: "hsl(0,0%,3.9%)"   },
  { id: "latte",        label: "Latte",        bg: "hsl(36,38%,86%)",   card: "hsl(36,60%,95%)",   borderColor: "hsl(36,24%,80%)",    textColor: "hsl(0,0%,3.9%)"   },
  { id: "sandstone",    label: "Sandstone",    bg: "hsl(28,50%,76%)",   card: "hsl(28,55%,82%)",   borderColor: "hsl(28,36%,67%)",    textColor: "hsl(0,0%,3.9%)"   },
  { id: "mist",         label: "Mist",         bg: "hsl(202,22%,87%)",  card: "hsl(202,28%,94%)",  borderColor: "hsl(202,16%,83%)",   textColor: "hsl(0,0%,3.9%)"   },
  { id: "lavender",     label: "Lavender",     bg: "hsl(263,22%,87%)",  card: "hsl(263,28%,94%)",  borderColor: "hsl(263,16%,83%)",   textColor: "hsl(0,0%,3.9%)"   },
  { id: "dream",        label: "Dream",        bg: "hsl(335,28%,88%)",  card: "hsl(335,34%,95%)",  borderColor: "hsl(335,18%,84%)",   textColor: "hsl(0,0%,3.9%)"   },
  { id: "cotton-candy", label: "Cotton Candy", bg: "hsl(335,55%,82%)",  card: "hsl(200,72%,88%)",  borderColor: "hsl(330,100%,60%)",  textColor: "hsl(0,0%,3.9%)"   },
  { id: "mint",         label: "Mint",         bg: "hsl(148,20%,83%)",  card: "hsl(145,26%,92%)",  borderColor: "hsl(148,16%,77%)",   textColor: "hsl(0,0%,3.9%)"   },
  { id: "garden",       label: "Garden",       bg: "hsl(130,26%,55%)",  card: "hsl(137,32%,72%)",  borderColor: "hsl(130,26%,46%)",   textColor: "hsl(0,0%,3.9%)"   },
];

const DARK_THEMES: DarkThemeOption[] = [
  { id: "new-moon",  label: "New Moon",  bg: "hsl(220,28%,6%)",   card: "hsl(221,39%,11%)",  borderColor: "hsl(215,20%,18%)",  textColor: "hsl(0,0%,98%)"    },
  { id: "charcoal",  label: "Charcoal",  bg: "hsl(220,5%,13%)",   card: "hsl(220,5%,20%)",   borderColor: "hsl(220,5%,26%)",   textColor: "hsl(0,0%,88%)"    },
  { id: "matrix",    label: "Matrix",    bg: "hsl(0,0%,2%)",      card: "hsl(120,8%,7%)",    borderColor: "hsl(120,10%,14%)",  textColor: "hsl(120,80%,60%)" },
  { id: "solarized", label: "Solarized", bg: "hsl(193,100%,11%)", card: "hsl(192,81%,14%)",  borderColor: "hsl(192,50%,22%)",  textColor: "hsl(180,7%,63%)"  },
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
  "lowMemoryMode",
  "autoUnpackArchives",
  "yellowHighlight",
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
      </CardContent>
    </Card>
  );
}

// ─── Tag Color Picker ─────────────────────────────────────────────────────────

function TagColorPicker({
  tagName,
  color,
  onPreview,
  onPickerClose,
  onSwatchSelect,
  onClear,
}: {
  tagName: string;
  color: string | null;
  onPreview: (tagName: string, color: string) => void;
  onPickerClose: (tagName: string) => void;
  onSwatchSelect: (tagName: string, color: string) => void;
  onClear: (tagName: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [popoverPos, setPopoverPos] = useState<React.CSSProperties>({});
  const triggerRef = useRef<HTMLButtonElement>(null);

  const handleOpen = () => {
    if (triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      const popoverH = 120; // approx height of popover
      const spaceBelow = window.innerHeight - rect.bottom;
      if (spaceBelow < popoverH) {
        setPopoverPos({ position: "fixed", left: rect.left, bottom: window.innerHeight - rect.top + 4 });
      } else {
        setPopoverPos({ position: "fixed", left: rect.left, top: rect.bottom + 4 });
      }
    }
    setOpen(v => !v);
  };

  return (
    <div className="relative flex items-center shrink-0">
      <button
        ref={triggerRef}
        type="button"
        title={color ? "Change color" : "Set color"}
        onClick={handleOpen}
        className="h-5 w-5 rounded-full border border-border transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        style={{ background: color ?? "hsl(var(--muted))" }}
      />
      {color && (
        <button
          type="button"
          title="Remove color"
          onClick={() => onClear(tagName)}
          className="absolute -right-2 -top-2 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-muted text-muted-foreground hover:bg-destructive hover:text-destructive-foreground text-[9px] leading-none"
        >
          ×
        </button>
      )}
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div style={{ ...popoverPos, zIndex: 50, width: 208 }} className="flex flex-col gap-2 rounded-lg border border-border bg-popover p-3 shadow-lg">
            {/* Native free-form picker */}
            <input
              type="color"
              className="h-8 w-full cursor-pointer rounded border border-border"
              value={color ?? "#888888"}
              onInput={e => onPreview(tagName, e.currentTarget.value)}
              onBlur={() => onPickerClose(tagName)}
            />
            {/* Swatches: 2 rows × 6 */}
            <div className="grid grid-cols-6 gap-2">
              {TAG_SWATCHES.map(swatch => (
                <button
                  key={swatch}
                  type="button"
                  title={swatch}
                  onClick={() => { onSwatchSelect(tagName, swatch); setOpen(false); }}
                  className={`h-6 w-6 rounded-full transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${color === swatch ? "ring-2 ring-offset-1 ring-primary" : "border border-black/10"}`}
                  style={{ background: swatch }}
                />
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Manage Tags ──────────────────────────────────────────────────────────────

function ManageTagsCard() {
  const [tags, setTags] = useState<TagRow[]>([]);
  const [visible, setVisible] = useState(INITIAL_VISIBLE);
  const [isLoading, setIsLoading] = useState(true);
  const [isDeleting, setIsDeleting] = useState<string | null>(null);
  const [isDeletingEmpty, setIsDeletingEmpty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmState, setConfirmState] = useState<{ x: number; y: number; name: string; count: number } | null>(null);
  const [deleteEmptyStatus, setDeleteEmptyStatus] = useState<"success" | "none" | null>(null);
  // Rename state
  const [renamingTag, setRenamingTag] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [isRenaming, setIsRenaming] = useState(false);
  const [pendingColorChanges, setPendingColorChanges] = useState<Record<string, string>>({});
  const renameInputRef = React.useRef<HTMLInputElement>(null);

  const load = async (silent = false) => {
    if (!silent) setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/tags?limit=${MAX_FETCH}`, { credentials: "include" });
      if (!res.ok) {
        const data = await res.json().catch(() => null) as { message?: string; error?: string } | null;
        setError(data?.message ?? data?.error ?? "Unable to load tags.");
        return;
      }
      const data = (await res.json()) as { tags?: TagRow[] };
      setTags(data.tags ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load tags.");
    } finally {
      if (!silent) setIsLoading(false);
    }
  };

  useEffect(() => {
    void load();
    const handler = () => void load(true);
    window.addEventListener(TAGS_UPDATED_EVENT, handler);
    return () => window.removeEventListener(TAGS_UPDATED_EVENT, handler);
  }, []);

  // Focus the rename input when it appears
  useEffect(() => {
    if (renamingTag) renameInputRef.current?.focus();
  }, [renamingTag]);

  const visibleTags = useMemo(() => tags.slice(0, visible), [tags, visible]);
  const canShowMore = visible < Math.min(tags.length, MAX_FETCH);

  const requestDelete = (tag: TagRow, e: React.MouseEvent) => {
    if (isDeleting) return;
    setConfirmState({ x: e.clientX, y: e.clientY, name: tag.name, count: tag.count });
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
        const data = await res.json().catch(() => null) as { message?: string; error?: string } | null;
        setError(data?.message ?? data?.error ?? "Unable to delete tag.");
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

  const startRename = (tag: TagRow) => {
    setRenamingTag(tag.name);
    setRenameValue(tag.name);
  };

  const cancelRename = () => {
    setRenamingTag(null);
    setRenameValue("");
  };

  const commitRename = async () => {
    if (!renamingTag) return;
    const trimmed = renameValue.trim();
    if (!trimmed || trimmed === renamingTag) { cancelRename(); return; }
    setIsRenaming(true);
    try {
      const res = await fetch(`/api/tags/${encodeURIComponent(renamingTag)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ name: trimmed }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null) as { message?: string; error?: string } | null;
        setError(data?.message ?? data?.error ?? "Unable to rename tag.");
        return;
      }
      setTags(prev => prev.map(t => t.name === renamingTag ? { ...t, name: trimmed } : t));
      emitTagsUpdated();
      cancelRename();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to rename tag.");
    } finally {
      setIsRenaming(false);
    }
  };

  const handleRenameKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") { e.preventDefault(); void commitRename(); }
    if (e.key === "Escape") { e.preventDefault(); cancelRename(); }
  };

  const persistTagColor = async (tagName: string, color: string | null) => {
    try {
      const res = await fetch(`/api/tags/${encodeURIComponent(tagName)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ color }),
      });
      if (res.ok) emitTagsUpdated();
    } catch {
      // Silently ignore - tag color is cosmetic, not critical
    }
  };

  const handleColorPreview = (tagName: string, color: string) => {
    setTags(prev => prev.map(t => t.name === tagName ? { ...t, color } : t));
    setPendingColorChanges(prev => ({ ...prev, [tagName]: color }));
  };

  const handleColorPickerClose = async (tagName: string) => {
    const nextColor = pendingColorChanges[tagName];
    if (nextColor === undefined) return;
    setPendingColorChanges(prev => {
      const copy = { ...prev };
      delete copy[tagName];
      return copy;
    });
    await persistTagColor(tagName, nextColor);
  };

  const handleColorSelect = async (tagName: string, color: string) => {
    setTags(prev => prev.map(t => t.name === tagName ? { ...t, color } : t));
    setPendingColorChanges(prev => { const copy = { ...prev }; delete copy[tagName]; return copy; });
    await persistTagColor(tagName, color);
  };


  const handleColorClear = async (tagName: string) => {
    setTags(prev => prev.map(t => t.name === tagName ? { ...t, color: null } : t));
    setPendingColorChanges(prev => {
      const copy = { ...prev };
      delete copy[tagName];
      return copy;
    });
    await persistTagColor(tagName, null);
  };

  const handleDeleteEmptyTags = async () => {
    if (isDeletingEmpty) return;
    setIsDeletingEmpty(true);
    setError(null);
    try {
      const res = await fetch("/api/tags/orphaned", {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null) as { message?: string; error?: string } | null;
        setError(data?.message ?? data?.error ?? "Unable to delete empty tags.");
        return;
      }

      const data = await res.json().catch(() => ({ deleted: 0 })) as { deleted?: number };
      const deleted = Number(data.deleted ?? 0);

      if (deleted > 0) {
        setDeleteEmptyStatus("success");
        await load();
        emitTagsUpdated();
      } else {
        setDeleteEmptyStatus("none");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to delete empty tags.");
    } finally {
      setIsDeletingEmpty(false);
      setTimeout(() => setDeleteEmptyStatus(null), 3000);
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 pb-4">
        <div>
          <CardTitle>Manage Tags</CardTitle>
          <CardDescription className="mt-1">Rename, color-code, and delete tags across your library.</CardDescription>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <Button variant="destructive" size="sm" onClick={() => void handleDeleteEmptyTags()} disabled={isDeletingEmpty}>
            {isDeletingEmpty ? "Deleting..." : "Delete empty tags"}
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
          <div className="space-y-1.5">
            {visibleTags.map(tag => (
              <div
                key={tag.name}
                className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm"
              >
                {/* Color swatch */}
                <TagColorPicker
                  tagName={tag.name}
                  color={tag.color}
                  onPreview={handleColorPreview}
                  onPickerClose={n => void handleColorPickerClose(n)}
                  onSwatchSelect={(n, c) => void handleColorSelect(n, c)}
                  onClear={n => void handleColorClear(n)}
                />

                {/* Tag name / rename input */}
                <div className="flex-1 min-w-0">
                  {renamingTag === tag.name ? (
                    <input
                      ref={renameInputRef}
                      value={renameValue}
                      onChange={e => setRenameValue(e.target.value)}
                      onKeyDown={handleRenameKeyDown}
                      onBlur={() => void commitRename()}
                      disabled={isRenaming}
                      className="w-full rounded border border-ring bg-background px-2 py-0.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                    />
                  ) : (
                    <button
                      type="button"
                      title="Click to rename"
                      onClick={() => startRename(tag)}
                      className="font-medium text-left hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
                    >
                      {tag.name}
                    </button>
                  )}
                </div>

                <span className="text-xs text-muted-foreground shrink-0">{tag.count} items</span>

                <Button
                  variant="outline"
                  size="sm"
                  onClick={(e) => requestDelete(tag, e)}
                  disabled={isDeleting === tag.name || renamingTag === tag.name}
                >
                  {isDeleting === tag.name ? "Deleting..." : "Delete"}
                </Button>
              </div>
            ))}
            {canShowMore && (
              <Button variant="outline" size="sm" className="mt-1" onClick={() => setVisible(v => v + 10)}>
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
        message={`Delete tag "${confirmState?.name}"? This will remove it from ${confirmState?.count ?? 0} item${(confirmState?.count ?? 0) === 1 ? "" : "s"}. This cannot be undone.`}
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

