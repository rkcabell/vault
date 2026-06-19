"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/apiFetch";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { CheckCircle2, XCircle, FolderPlus, Loader2, Save, X } from "lucide-react";
import { DirectoryPicker } from "./DirectoryPicker";

type IndexConfig = { roots: string[] };
type SaveResult = { ok: boolean; message: string };

function isAbsolutePath (value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

/**
 * Manage the in-place indexing allow-list. Changes are saved to user preferences
 * and take effect immediately — no restart required.
 */
export function IndexingSettingsCard () {
  const [config, setConfig] = useState<IndexConfig | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [roots, setRoots] = useState<string[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<SaveResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch("/api/server/index-config", { credentials: "include" })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((c: IndexConfig) => {
        if (cancelled) return;
        setConfig(c);
        setRoots(c.roots);
      })
      .catch(() => !cancelled && setLoadError(true));
    return () => { cancelled = true; };
  }, []);

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

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveResult(null);
    try {
      const res = await apiFetch("/api/server/index-config", {
        method: "PATCH",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roots }),
      });
      const body = await res.json().catch(() => null);
      if (res.ok && body?.ok) {
        setConfig({ roots: body.roots });
        setSaveResult({ ok: true, message: "Saved." });
      } else {
        setSaveResult({ ok: false, message: body?.message ?? `Failed to save (${res.status}).` });
      }
    } catch (err) {
      setSaveResult({ ok: false, message: err instanceof Error ? err.message : "Network error" });
    } finally {
      setSaving(false);
    }
  }, [roots]);

  const isDirty = config !== null && JSON.stringify(roots) !== JSON.stringify(config.roots);

  return (
    <Card>
      <CardHeader className="pb-4">
        <CardTitle>In-place indexing</CardTitle>
        <CardDescription className="mt-1">
          Folders Vault may index without copying — it reads originals where they sit and writes only
          thumbnails and OCR to its own storage. The source folder is never modified.
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
              No folders allowed yet — indexing is disabled. Add a folder to enable it.
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
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setPickerOpen(true)} className="gap-1.5">
            <FolderPlus className="h-4 w-4" />
            Add folder…
          </Button>
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
    </Card>
  );
}
