"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/apiFetch";
import { usePreferences } from "@/hooks/usePreferences";
import { useAppInit } from "@/hooks/useAppInit";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { CheckCircle2, XCircle, FolderPlus, Loader2, Save, X } from "lucide-react";
import { DirectoryPicker } from "./DirectoryPicker";
import { ReconcileCheck } from "./ReconcileCheck";

type IndexConfig = { roots: string[]; blacklist: string[]; excludeFolders: string[]; skipNonContent: boolean };
/** What the built-in skipNonContent filter does, reported by the API so the UI never drifts. */
type SkipInfo = { buildDirNames: string[]; buildDirSuffixes: string[]; contentExtensions: string[] };
type SaveResult = { ok: boolean; message: string };

function isAbsolutePath (value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

/**
 * The top-most allowed root: prefer roots that are not nested inside another
 * allowed root, then the shallowest path, keeping config order on ties. The
 * exclude-folder picker starts here — exclusions only have an effect inside
 * the allowed roots, so that is where browsing should begin.
 */
function highestAllowedRoot (roots: string[]): string | undefined {
  if (roots.length === 0) return undefined;
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const isInside = (child: string, parent: string) => {
    const c = norm(child);
    const p = norm(parent);
    return c !== p && c.startsWith(p + "/");
  };
  const topLevel = roots.filter(r => !roots.some(other => other !== r && isInside(r, other)));
  const depth = (p: string) => norm(p).split("/").length;
  return [...topLevel].sort((a, b) => depth(a) - depth(b))[0] ?? roots[0];
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
  const { prefs, updatePreferences } = usePreferences();
  const { isLoaded: initSettled } = useAppInit();
  const [config, setConfig] = useState<IndexConfig | null>(null);
  const [skipInfo, setSkipInfo] = useState<SkipInfo | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [roots, setRoots] = useState<string[]>([]);
  const [blacklist, setBlacklist] = useState<string[]>([]);
  const [excludeFolders, setExcludeFolders] = useState<string[]>([]);
  const [skipNonContent, setSkipNonContent] = useState(true);
  // Staged like everything else in this card, against a baseline copy rather
  // than the live preferences store. The store is shared: a second tab or the
  // late /api/init seed writing to it would move the comparison value onto the
  // staged value, and Save goes dark with the toggle unsaved.
  const [ignoreHidden, setIgnoreHidden] = useState<boolean | null>(null);
  const [savedIgnoreHidden, setSavedIgnoreHidden] = useState<boolean | null>(null);
  const [extInput, setExtInput] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [excludePickerOpen, setExcludePickerOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<SaveResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch("/api/server/index-config", { credentials: "include" })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((c: IndexConfig & { skipInfo?: SkipInfo }) => {
        if (cancelled) return;
        setConfig({ roots: c.roots, blacklist: c.blacklist ?? [], excludeFolders: c.excludeFolders ?? [], skipNonContent: c.skipNonContent ?? true });
        setRoots(c.roots);
        setBlacklist(c.blacklist ?? []);
        setExcludeFolders(c.excludeFolders ?? []);
        setSkipNonContent(c.skipNonContent ?? true);
        setSkipInfo(c.skipInfo ?? null);
      })
      .catch(() => !cancelled && setLoadError(true));
    return () => { cancelled = true; };
  }, []);

  // Keyed on /api/init settling, not on the preferences store's own isLoaded:
  // that flips as soon as localStorage is read, so seeding from it captures a
  // guess and never re-seeds when the server's value lands a moment later.
  useEffect(() => {
    if (!initSettled) return;
    setSavedIgnoreHidden(prev => (prev === null ? prefs.ignoreHiddenFiles : prev));
    setIgnoreHidden(prev => (prev === null ? prefs.ignoreHiddenFiles : prev));
  }, [initSettled, prefs.ignoreHiddenFiles]);

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
    // Preferences write through their own debounced PATCH, so this is fire-and-
    // forget rather than part of the index-config round trip below.
    if (ignoreHidden !== null && ignoreHidden !== savedIgnoreHidden) {
      updatePreferences({ ignoreHiddenFiles: ignoreHidden });
      setSavedIgnoreHidden(ignoreHidden);
    }
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
        // Removing the root that held it leaves the send-files folder outside
        // the allow-list, so the server clears it. Silence here would read as
        // "sending still works" until the next send failed.
        setSaveResult({
          ok: true,
          message: body.ingestFolderCleared
            ? "Saved. The folder for files sent to Vault was inside a folder you removed, so sending is switched off until you choose another on Add files."
            : "Saved.",
        });
      } else {
        setSaveResult({ ok: false, message: body?.message ?? `Failed to save (${res.status}).` });
      }
    } catch (err) {
      setSaveResult({ ok: false, message: err instanceof Error ? err.message : "Network error" });
    } finally {
      setSaving(false);
    }
  }, [roots, blacklist, excludeFolders, skipNonContent, ignoreHidden, savedIgnoreHidden, updatePreferences]);

  const isDirty =
    (config !== null &&
      (JSON.stringify(roots) !== JSON.stringify(config.roots) ||
        JSON.stringify(blacklist) !== JSON.stringify(config.blacklist) ||
        JSON.stringify(excludeFolders) !== JSON.stringify(config.excludeFolders) ||
        skipNonContent !== config.skipNonContent)) ||
    (ignoreHidden !== null && ignoreHidden !== savedIgnoreHidden);

  // No allowed folders = indexing is off; the dependent options have no effect
  // until at least one folder is whitelisted, so present them disabled.
  const indexingEnabled = roots.length > 0;
  const dimWhenDisabled = indexingEnabled ? "" : "opacity-50";

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
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">
                No folders whitelisted for indexing
              </p>
              <p className="text-xs text-muted-foreground">
                Add an allowed folder to enable the indexing options below.
              </p>
            </div>
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

        <div className={`space-y-2 ${dimWhenDisabled}`}>
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
                    disabled={!indexingEnabled}
                    aria-label={`Remove ${folder}`}
                    className="shrink-0 text-muted-foreground hover:text-destructive disabled:pointer-events-none"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <Button variant="outline" size="sm" disabled={!indexingEnabled} onClick={() => setExcludePickerOpen(true)} className="gap-1.5">
            <FolderPlus className="h-4 w-4" />
            Exclude folder…
          </Button>
        </div>

        <div className={`space-y-2 ${dimWhenDisabled}`}>
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Excluded filetypes
          </span>
          <p className="text-xs text-muted-foreground">
            Add file extensions to skip. Applies on top of the built-in skip filter below.
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
                    disabled={!indexingEnabled}
                    aria-label={`Remove .${ext}`}
                    className="text-muted-foreground hover:text-destructive disabled:pointer-events-none"
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
              disabled={!indexingEnabled}
              onChange={e => setExtInput(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addExt(); } }}
              placeholder="Add extension, e.g. tmp"
              className="w-48 rounded-md border border-border bg-card px-1.5 py-1.5 font-mono text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            />
            <Button variant="outline" size="sm" onClick={addExt} disabled={!indexingEnabled || !normalizeExt(extInput)}>
              Add
            </Button>
          </div>
        </div>

        <div className={`rounded-md border border-border px-3 py-2.5 ${dimWhenDisabled}`}>
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              checked={skipNonContent}
              disabled={!indexingEnabled}
              onChange={e => { setSkipNonContent(e.target.checked); setSaveResult(null); }}
              className="mt-0.5 h-4 w-4 shrink-0"
            />
            <span className="space-y-0.5">
              <span className="block text-sm font-medium">Skip build &amp; dependency files (recommended)</span>
              <span className="block text-xs text-muted-foreground">
                Skips source code, binaries, unrecognized file types, and common developer folders (node_modules, .git, dist, vcpkg, caches, ...)
              </span>
            </span>
          </label>
          {skipInfo && (
            <details className="ml-7 mt-1.5">
              <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                What gets skipped?
              </summary>
              <div className="mt-2 space-y-2">
                <div>
                  <p className="text-xs font-medium">Skipped folders</p>
                  <p className="break-words font-mono text-xs text-muted-foreground">
                    {skipInfo.buildDirNames.join(", ")}
                    {skipInfo.buildDirSuffixes.length > 0 &&
                      `, *${skipInfo.buildDirSuffixes.join(", *")}`}
                  </p>
                </div>
                <div>
                  <p className="text-xs font-medium">Only these file types are indexed</p>
                  <p className="break-words font-mono text-xs text-muted-foreground">
                    {skipInfo.contentExtensions.map(e => `.${e}`).join(", ")}
                  </p>
                </div>
              </div>
            </details>
          )}
        </div>

        <div className={`rounded-md border border-border px-3 py-2.5 ${dimWhenDisabled}`}>
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              checked={ignoreHidden ?? prefs.ignoreHiddenFiles}
              disabled={!indexingEnabled || ignoreHidden === null}
              onChange={e => { setIgnoreHidden(e.target.checked); setSaveResult(null); }}
              className="mt-0.5 h-4 w-4 shrink-0"
            />
            <span className="space-y-0.5">
              <span className="block text-sm font-medium">Ignore hidden files</span>
              <span className="block text-xs text-muted-foreground">
                Skip dotfiles and hidden folders (e.g. .DS_Store, .immich).
              </span>
            </span>
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={handleSave} disabled={saving || !isDirty} className="gap-1.5">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save
          </Button>
          {/* Everything above is staged, and leaving the page drops it. The Add
              files page adds a root immediately, so silence here reads as saved. */}
          {isDirty && (
            <span className="text-xs text-muted-foreground" role="status">
              Unsaved changes — nothing here takes effect until you save.
            </span>
          )}
        </div>

        {/* Reconciles the *saved* config, so it sits below Save rather than
            among the unsaved editors above it. */}
        <div className="border-t border-border pt-4">
          <ReconcileCheck enabled={indexingEnabled} />
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
          initialPath={highestAllowedRoot(roots) ?? excludeFolders[0]}
          onSelect={addExcludeFolder}
          onClose={() => setExcludePickerOpen(false)}
        />
      )}
    </Card>
  );
}
