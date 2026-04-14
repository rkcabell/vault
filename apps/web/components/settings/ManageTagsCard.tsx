"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { ConfirmPopover } from "@/components/ui/ConfirmPopover";
import { emitTagsUpdated, TAGS_UPDATED_EVENT } from "@/lib/tags";

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

const MAX_FETCH      = 50;
const INITIAL_VISIBLE = 20;

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
      const popoverH = 120;
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
            <input
              type="color"
              className="h-8 w-full cursor-pointer rounded border border-border"
              value={color ?? "#888888"}
              onInput={e => onPreview(tagName, e.currentTarget.value)}
              onBlur={() => onPickerClose(tagName)}
            />
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

export function ManageTagsCard() {
  const [tags, setTags] = useState<TagRow[]>([]);
  const [visible, setVisible] = useState(INITIAL_VISIBLE);
  const [isLoading, setIsLoading] = useState(true);
  const [isDeleting, setIsDeleting] = useState<string | null>(null);
  const [isDeletingEmpty, setIsDeletingEmpty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmState, setConfirmState] = useState<{ x: number; y: number; name: string; count: number } | null>(null);
  const [deleteEmptyStatus, setDeleteEmptyStatus] = useState<"success" | "none" | null>(null);
  const [renamingTag, setRenamingTag] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [isRenaming, setIsRenaming] = useState(false);
  const [pendingColorChanges, setPendingColorChanges] = useState<Record<string, string>>({});
  const renameInputRef = useRef<HTMLInputElement>(null);

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
                <TagColorPicker
                  tagName={tag.name}
                  color={tag.color}
                  onPreview={handleColorPreview}
                  onPickerClose={n => void handleColorPickerClose(n)}
                  onSwatchSelect={(n, c) => void handleColorSelect(n, c)}
                  onClear={n => void handleColorClear(n)}
                />
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
