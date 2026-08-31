"use client";

import { useState } from "react";

import { apiFetch } from "@/lib/apiFetch";
import { Button } from "@/components/ui/Button";
import { FolderPlus, Loader2 } from "lucide-react";
import { DirectoryPicker } from "./DirectoryPicker";

/**
 * Add-only mirror of the allowed-roots list in `IndexingSettingsCard`, so the
 * Add files page can whitelist a folder without a detour through settings.
 * Removal stays behind that card's staged Save — un-whitelisting a root drops a
 * whole tree out of indexing, which is not a one-click action.
 */
export function IndexRootAdder ({
  roots,
  onAdded,
  disabled,
  label = "Add folder…",
}: {
  roots: string[];
  onAdded: (roots: string[]) => void;
  disabled?: boolean;
  label?: string;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = async (path: string) => {
    setPickerOpen(false);
    const trimmed = path.trim();
    if (!trimmed || roots.includes(trimmed)) return;

    setSaving(true);
    setError(null);
    try {
      // Only `roots` is sent: the other index-config fields are left untouched
      // when omitted, so this never clobbers exclusions edited in settings.
      const res = await apiFetch("/api/server/index-config", {
        method: "PATCH",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roots: [...roots, trimmed] }),
      });
      const body = await res.json().catch(() => null);
      if (res.ok && body?.ok) onAdded(body.roots as string[]);
      else setError(body?.message ?? `Could not add the folder (${res.status}).`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="gap-1.5"
        disabled={disabled || saving}
        onClick={() => setPickerOpen(true)}
      >
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <FolderPlus className="h-4 w-4" />}
        {label}
      </Button>

      {error && <p className="mt-2 break-all text-sm text-destructive" role="status">{error}</p>}

      {pickerOpen && (
        <DirectoryPicker
          title="Allow a folder for indexing"
          initialPath={roots[0]}
          onSelect={path => void add(path)}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </>
  );
}
