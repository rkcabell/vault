"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/apiFetch";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { CheckCircle2, XCircle, FolderPlus, Loader2, Save, X } from "lucide-react";
import { DirectoryPicker } from "./DirectoryPicker";

type IndexConfig = { roots: string[]; blacklist: string[]; excludeFolders: string[]; skipNonContent: boolean };
type SaveResult = { ok: boolean; message: string };

function isAbsolutePath (value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

/** Normalize a typed extension: lowercase, strip leading dots, trim. */
function normalizeExt (value: string): string {
  return value.trim().toLowerCase().replace(/^\.+/, "");
}

/**
 * Manage the in-place indexing allow-list. Changes are saved to user preferences
 * and take effect immediately — no restart required.
 */
export function IndexingSettingsCard () {
  const [config, setConfig] = useState<IndexConfig | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [roots, setRoots] = useState<string[]>([]);
  const [blacklist, setBlacklist] = useState<string[]>([]);
  const [excludeFolders, setExcludeFolders] = useState<string[]>([]);
  const [skipNonContent, setSkipNonContent] = useState(true);
  const [extInput, setExtInput] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [excludePickerOpen, setExcludePickerOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<SaveResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch("/api/server/index-config", { credentials: "include" })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((c: IndexConfig) => {
        if (cancelled) return;
        setConfig({ roots: c.roots, blacklist: c.blacklist ?? [], excludeFolders: c.excludeFolders ?? [], skipNonContent: c.skipNonContent ?? true });
        setRoots(c.roots);
        setBlacklist(c.blacklist ?? []);
        setExcludeFolders(c.excludeFolders ?? []);
        setSkipNonContent(c.skipNonContent ?? true);
      })
      .catch(() => !cancelled && setLoadError(true));
    return () => { cancelled = true; };
  }, []);

  const addExt = () => {
    const ext = normalizeExt(extInput);
    setExtInput("");
    if (!ext) return;
    setBlacklist(prev => (prev.includes(ext) ? prev : [...prev, ext]));
    setSaveResult(null);
  };

  const removeExt = (ext: string) => {
    setBlacklist(prev => prev.filter(e => e !== ext));
    setSaveResult(null);
  };

  const addRoot = (path: string) => {
    setPickerOpen(false);
    const trimmed = path.trim();
    if (!trimmed || !isAbsolutePath(trimmed)) return;
    setRoots(prev => (prev.includes(trimmed) ? prev : [...prev, trimmed]));
    setSaveResult(null);
  };

  const removeRoot = (path: string) => {
    setRoots(prev => prev.filter(r => r !== path));
    setSaveResult(null);
  };

  const addExcludeFolder = (path: string) => {
    setExcludePickerOpen(false);
    const trimmed = path.trim();
    if (!trimmed || !isAbsolutePath(trimmed)) return;
    setExcludeFolders(prev => (prev.includes(trimmed) ? prev : [...prev, trimmed]));
    setSaveResult(null);
  };

  const removeExcludeFolder = (path: string) => {
    setExcludeFolders(prev => prev.filter(p => p !== path));
    setSaveResult(null);
  };

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveResult(null);
    try {
      const res = await apiFetch("/api/server/index-config", {
        method: "PATCH",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roots, blacklist, excludeFolders, skipNonContent }),
      });
      const body = await res.json().catch(() => null);
      if (res.ok && body?.ok) {
        setConfig({ roots: body.roots, blacklist: body.blacklist ?? [], excludeFolders: body.excludeFolders ?? [], skipNonContent: body.skipNonContent ?? true });
        setBlacklist(body.blacklist ?? []);
        setExcludeFolders(body.excludeFolders ?? []);
        setSkipNonContent(body.skipNonContent ?? true);
        setSaveResult({ ok: true, message: "Saved." });
      } else {
        setSaveResult({ ok: false, message: body?.message ?? `Failed to save (${res.status}).` });
      }
    } catch (err) {
      setSaveResult({ ok: false, message: err instanceof Error ? err.message : "Network error" });
    } finally {
      setSaving(false);
    }
  }, [roots, blacklist, excludeFolders, skipNonContent]);

  const isDirty =
    config !== null &&
    (JSON.stringify(roots) !== JSON.stringify(config.roots) ||
      JSON.stringify(blacklist) !== JSON.stringify(config.blacklist) ||
      JSON.stringify(excludeFolders) !== JSON.stringify(config.excludeFolders) ||
      skipNonContent !== config.skipNonContent);

  return (
    <Card>
      <CardHeader className="pb-4">
        <CardTitle>In-place indexing</CardTitle>
        <CardDescription className="mt-1">
          Vault can index your local files without copying them. Only explicitly allowed folders are indexed. Excluded folders are always skipped.
        </CardDescription>
      </CardHeader>
      <CardContent className="px-6 pb-6 pt-0 space-y-4">
        {loadError && (
          <p className="text-sm text-destructive">Could not load indexing config.</p>
        )}

        <div className="space-y-2">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Allowed folders
          </span>
          {roots.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No folders whitelisted for indexing
            </p>
          ) : (
            <ul className="space-y-1.5">
              {roots.map(root => (
                <li
                  key={root}
                  className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2"
                >
                  <span className="break-all font-mono text-sm">{root}</span>
                  <button
                    onClick={() => removeRoot(root)}
                    aria-label={`Remove ${root}`}
                    className="shrink-0 text-muted-foreground hover:text-destructive"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <Button variant="outline" size="sm" onClick={() => setPickerOpen(true)} className="gap-1.5">
            <FolderPlus className="h-4 w-4" />
            Add folder…
          </Button>
        </div>

        <div className="space-y-2">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Excluded folders
          </span>
          <p className="text-xs text-muted-foreground">
            Folders to skip while indexing
          </p>
          {excludeFolders.length > 0 && (
            <ul className="space-y-1.5">
              {excludeFolders.map(folder => (
                <li
                  key={folder}
                  className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2"
                >
                  <span className="break-all font-mono text-sm">{folder}</span>
                  <button
                    onClick={() => removeExcludeFolder(folder)}
                    aria-label={`Remove ${folder}`}
                    className="shrink-0 text-muted-foreground hover:text-destructive"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <Button variant="outline" size="sm" onClick={() => setExcludePickerOpen(true)} className="gap-1.5">
            <FolderPlus className="h-4 w-4" />
            Exclude folder…
          </Button>
        </div>

        <div className="space-y-2">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Excluded filetypes
          </span>
          <p className="text-xs text-muted-foreground">
            Add file extensions to skip
          </p>
          {blacklist.length > 0 && (
            <ul className="flex flex-wrap gap-1.5">
              {blacklist.map(ext => (
                <li
                  key={ext}
                  className="flex items-center gap-1 rounded-full border border-border px-2.5 py-1 font-mono text-xs"
                >
                  .{ext}
                  <button
                    onClick={() => removeExt(ext)}
                    aria-label={`Remove .${ext}`}
                    className="text-muted-foreground hover:text-destructive"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex items-center gap-2">
            <input
              value={extInput}
              onChange={e => setExtInput(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addExt(); } }}
              placeholder="Add extension, e.g. tmp"
              className="w-48 rounded-md border border-border bg-card px-1.5 py-1.5 font-mono text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            />
            <Button variant="outline" size="sm" onClick={addExt} disabled={!normalizeExt(extInput)}>
              Add
            </Button>
          </div>
        </div>

        <label className="flex items-start gap-3 rounded-md border border-border px-3 py-2.5">
          <input
            type="checkbox"
            checked={skipNonContent}
            onChange={e => { setSkipNonContent(e.target.checked); setSaveResult(null); }}
            className="mt-0.5 h-4 w-4 shrink-0"
          />
          <span className="space-y-0.5">
            <span className="block text-sm font-medium">Skip build &amp; dependency files</span>
            <span className="block text-xs text-muted-foreground">
              Ignore dependency/build folders (node_modules, dist, vpkgs) and non-content files
              (binaries, source code, build artifacts)
            </span>
          </span>
        </label>

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={handleSave} disabled={saving || !isDirty} className="gap-1.5">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save
          </Button>
        </div>

        {saveResult && (
          <div
            className={`flex items-start gap-2 rounded-md border p-3 text-sm ${
              saveResult.ok ? "border-primary/40 text-foreground" : "border-destructive/40 text-destructive"
            }`}
            role="status"
          >
            {saveResult.ok ? (
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            ) : (
              <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
            )}
            <span className="break-all">{saveResult.message}</span>
          </div>
        )}
      </CardContent>

      {pickerOpen && (
        <DirectoryPicker
          initialPath={roots[0]}
          onSelect={addRoot}
          onClose={() => setPickerOpen(false)}
        />
      )}

      {excludePickerOpen && (
        <DirectoryPicker
          initialPath={excludeFolders[0] ?? roots[0]}
          onSelect={addExcludeFolder}
          onClose={() => setExcludePickerOpen(false)}
        />
      )}
    </Card>
  );
}
