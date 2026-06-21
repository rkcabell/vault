"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/apiFetch";
import { Button } from "@/components/ui/Button";
import { Folder, FolderPlus, FolderUp, HardDrive, Loader2, X } from "lucide-react";

type DriveRoot = { path: string; freeBytes: number | null; totalBytes: number | null };

type DirListing = {
  path: string;
  parent: string | null;
  dirs: { name: string; path: string }[];
  roots: DriveRoot[];
  redirected?: boolean;
};

/** Compact binary byte size, e.g. "120 GB". */
function formatBytes(n: number): string {
  const GB = 1024 ** 3;
  const TB = 1024 ** 4;
  if (n >= TB) return `${(n / TB).toFixed(1)} TB`;
  if (n >= GB) return `${(n / GB).toFixed(n < 10 * GB ? 1 : 0)} GB`;
  return `${Math.max(1, Math.round(n / 1024 ** 2))} MB`;
}

/**
 * Browse directories on the SERVER (not the client machine) so the user can
 * pick STORAGE_FS_PATH, which must exist inside the API/worker container.
 * Backed by GET /api/server/fs/list.
 */
export function DirectoryPicker({
  initialPath,
  onSelect,
  onClose,
  title = "Select folder",
}: {
  initialPath?: string;
  onSelect: (path: string) => void;
  onClose: () => void;
  title?: string;
}) {
  const [listing, setListing] = useState<DirListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);

  const load = useCallback(async (p?: string) => {
    setLoading(true);
    setError(null);
    // Reset the inline create form whenever we navigate.
    setCreating(false);
    setNewName("");
    setCreateError(null);
    try {
      const qs = p ? `?path=${encodeURIComponent(p)}` : "";
      const res = await apiFetch(`/api/server/fs/list${qs}`, { credentials: "include" });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.message ?? `Could not list directory (${res.status}).`);
        return;
      }
      setListing(body as DirListing);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(initialPath);
  }, [load, initialPath]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = newName.trim();
    if (!name || !listing) return;
    setCreateError(null);
    try {
      const res = await apiFetch("/api/server/fs/mkdir", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parent: listing.path, name }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setCreateError(body?.message ?? `Could not create folder (${res.status}).`);
        return;
      }
      // Navigate into the newly created folder so "Use this folder" selects it.
      await load(body.path);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Network error.");
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="flex max-h-[70vh] w-full max-w-lg flex-col rounded-lg border border-border bg-card shadow-lg"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h3 className="text-sm font-semibold">{title}</h3>
          <button onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="border-b border-border px-4 py-2">
          <p className="text-xs text-muted-foreground">Current path</p>
          <p className="break-all font-mono text-sm">{listing?.path ?? "…"}</p>
          {listing?.redirected && (
            <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
              That path doesn&apos;t exist yet — showing the nearest existing folder.
            </p>
          )}
        </div>

        {listing && listing.roots.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-4 py-2">
            <span className="text-xs text-muted-foreground">Drives:</span>
            {listing.roots.map(r => (
              <button
                key={r.path}
                onClick={() => load(r.path)}
                title={
                  r.freeBytes != null && r.totalBytes != null
                    ? `${formatBytes(r.freeBytes)} free of ${formatBytes(r.totalBytes)}`
                    : undefined
                }
                className="inline-flex items-center gap-1.5 rounded border border-border px-2 py-1 text-xs hover:bg-accent"
              >
                <HardDrive className="h-3 w-3 shrink-0" />
                <span className="font-medium">{r.path}</span>
                {r.freeBytes != null && (
                  <span className="text-muted-foreground">{formatBytes(r.freeBytes)} free</span>
                )}
              </button>
            ))}
          </div>
        )}

        <div className="min-h-[12rem] flex-1 overflow-y-auto px-2 py-2">
          {loading ? (
            <div className="flex items-center gap-2 px-2 py-3 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : error ? (
            <p className="px-2 py-3 text-sm text-destructive">{error}</p>
          ) : (
            <ul className="space-y-0.5">
              {/* New folder — created inside the current path */}
              <li>
                {creating ? (
                  <form onSubmit={handleCreate} className="flex items-center gap-2 px-2 py-1">
                    <FolderPlus className="h-4 w-4 shrink-0 text-primary" />
                    <input
                      autoFocus
                      value={newName}
                      onChange={e => setNewName(e.target.value)}
                      placeholder="New folder name"
                      aria-label="New folder name"
                      className="min-w-0 flex-1 rounded border border-input bg-background px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                    <Button type="submit" size="sm" disabled={!newName.trim()}>Create</Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => { setCreating(false); setNewName(""); setCreateError(null); }}
                    >
                      Cancel
                    </Button>
                  </form>
                ) : (
                  <button
                    onClick={() => setCreating(true)}
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm text-primary hover:bg-accent"
                  >
                    <FolderPlus className="h-4 w-4 shrink-0" />
                    <span>New folder…</span>
                  </button>
                )}
                {createError && (
                  <p className="px-2 pt-1 text-xs text-destructive">{createError}</p>
                )}
              </li>
              {listing?.parent && (
                <li>
                  <button
                    onClick={() => load(listing.parent!)}
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent"
                  >
                    <FolderUp className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="text-muted-foreground">.. (parent)</span>
                  </button>
                </li>
              )}
              {listing?.dirs.length === 0 && (
                <li className="px-2 py-3 text-sm text-muted-foreground">No subfolders here.</li>
              )}
              {listing?.dirs.map(d => (
                <li key={d.path}>
                  <button
                    onClick={() => load(d.path)}
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
                  >
                    <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="truncate">{d.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-3">
          <p className="truncate text-xs text-muted-foreground">
            Selecting uses the current path shown above.
          </p>
          <div className="flex shrink-0 gap-2">
            <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
            <Button
              size="sm"
              disabled={!listing?.path}
              onClick={() => listing && onSelect(listing.path)}
            >
              Use this folder
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
