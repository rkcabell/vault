"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch } from "@/lib/apiFetch";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { CheckCircle2, XCircle, Copy, Loader2, FolderOpen, RefreshCw } from "lucide-react";
import { DirectoryPicker } from "./DirectoryPicker";

type StorageConfig = {
  driver: "fs";
  fsPath: string | null;
  canApply: boolean;
};

type TestResult = { ok: boolean; message: string };
type ApplyResult = { ok: boolean; message: string };

const inputClass =
  "w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const inputErrorClass = "border-destructive focus-visible:ring-destructive";

function isAbsolutePath(value: string): boolean {
  // POSIX absolute (/data/vault) or Windows absolute (C:\data) — fs paths must be absolute.
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

function validateFsPath(fsPath: string): string | null {
  if (!fsPath.trim()) return "Required.";
  if (!isAbsolutePath(fsPath.trim())) return "Must be an absolute path (e.g. /data/vault).";
  return null;
}

export function StorageSettingsCard() {
  const [config, setConfig] = useState<StorageConfig | null>(null);
  const [loadError, setLoadError] = useState(false);

  const [fsPath, setFsPath] = useState("/data/vault");
  const [snippet, setSnippet] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<ApplyResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch("/api/server/storage-config", { credentials: "include" })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((c: StorageConfig) => {
        if (cancelled) return;
        setConfig(c);
        setFsPath(c.fsPath ?? "/data/vault");
      })
      .catch(() => !cancelled && setLoadError(true));
    return () => { cancelled = true; };
  }, []);

  const pathError = useMemo(() => validateFsPath(fsPath), [fsPath]);
  const isValid = pathError === null;

  const handleGenerate = () => {
    if (!isValid) return;
    setSnippet(`STORAGE_FS_PATH=${fsPath.trim()}`);
    setCopied(false);
  };

  const handleCopy = useCallback(async () => {
    if (!snippet) return;
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable — user can select manually */
    }
  }, [snippet]);

  const handleTest = useCallback(async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await apiFetch("/api/server/storage/test", { method: "POST", credentials: "include" });
      const body = await res.json().catch(() => null);
      if (res.ok && body?.ok) {
        setTestResult({ ok: true, message: `Reachable and writable (${body.durationMs} ms).` });
      } else {
        const detail = body?.message ?? `HTTP ${res.status}`;
        const code = body?.code ? ` [${body.code}]` : "";
        setTestResult({ ok: false, message: `${detail}${code}` });
      }
    } catch (err) {
      setTestResult({ ok: false, message: err instanceof Error ? err.message : "Network error" });
    } finally {
      setTesting(false);
    }
  }, []);

  const handleApply = useCallback(async () => {
    if (!isValid) return;
    const moving = !!config?.fsPath && config.fsPath !== fsPath.trim();
    const confirmMsg = moving
      ? `Point storage at "${fsPath.trim()}" and write your .env?\n\n` +
        `Existing files are NOT moved — they stay at the current path and will appear ` +
        `missing until you move them or point back.`
      : "Write these storage settings to your .env?";
    if (!window.confirm(confirmMsg)) return;

    setApplying(true);
    setApplyResult(null);
    try {
      const res = await apiFetch("/api/server/storage-config", {
        method: "PATCH",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fsPath: fsPath.trim() }),
      });
      const body = await res.json().catch(() => null);
      if (res.ok && body?.ok) {
        setApplyResult({
          ok: true,
          message: `Saved to ${body.envPath}. Restart Vault to apply (stop vaultdev, then run it again).`,
        });
      } else {
        setApplyResult({ ok: false, message: body?.message ?? `Failed to write env (${res.status}).` });
      }
    } catch (err) {
      setApplyResult({ ok: false, message: err instanceof Error ? err.message : "Network error" });
    } finally {
      setApplying(false);
    }
  }, [fsPath, isValid, config]);

  return (
    <Card>
      <CardHeader className="pb-4">
        <CardTitle>Storage</CardTitle>
        <CardDescription className="mt-1">
          Where Vault stores file originals and thumbnails.
        </CardDescription>
      </CardHeader>
      <CardContent className="px-6 pb-6 pt-0 space-y-6">
        {/* Active storage location (read-only) */}
        <div className="flex items-start justify-between gap-4 rounded-lg border border-border p-3">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">Storage folder</span>
              {config ? (
                <Badge variant="secondary">Filesystem</Badge>
              ) : loadError ? (
                <Badge variant="destructive">Unknown</Badge>
              ) : (
                <Badge variant="outline">Loading…</Badge>
              )}
            </div>
            {config?.fsPath && (
              <p className="text-xs text-muted-foreground font-mono break-all">{config.fsPath}</p>
            )}
            <p className="text-xs text-muted-foreground">
              The currently running location. Changes below take effect after a restart.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={handleTest} disabled={testing} className="shrink-0 gap-1.5">
            {testing && <Loader2 className="h-4 w-4 animate-spin" />}
            Test storage
          </Button>
        </div>

        {testResult && (
          <div
            className={`flex items-start gap-2 rounded-md border p-3 text-sm ${
              testResult.ok
                ? "border-primary/40 text-foreground"
                : "border-destructive/40 text-destructive"
            }`}
            role="status"
          >
            {testResult.ok ? (
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            ) : (
              <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
            )}
            <span className="break-all">{testResult.message}</span>
          </div>
        )}

        {/* Configuration */}
        <div className="space-y-4">
          <div>
            <h3 className="text-sm font-medium">Change storage folder</h3>
            <p className="text-xs text-muted-foreground">
              {config?.canApply
                ? "Apply writes the path to your .env; restart Vault to switch. Or copy the snippet to apply manually."
                : "In production the env is managed by your deployment — copy the snippet and apply it there, then restart."}
            </p>
          </div>

          <div className="space-y-1">
            <label htmlFor="storage-fs-path" className="text-sm font-medium">
              Storage path (STORAGE_FS_PATH)
            </label>
            <div className="flex gap-2">
              <input
                id="storage-fs-path"
                type="text"
                value={fsPath}
                placeholder="/data/vault"
                aria-invalid={pathError ? true : undefined}
                aria-describedby={pathError ? "storage-fs-path-error" : undefined}
                onChange={e => setFsPath(e.target.value)}
                className={pathError ? `${inputClass} ${inputErrorClass}` : inputClass}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setPickerOpen(true)}
                className="shrink-0 gap-1.5"
              >
                <FolderOpen className="h-4 w-4" />
                Browse
              </Button>
            </div>
            {pathError && (
              <p id="storage-fs-path-error" className="text-xs text-destructive">{pathError}</p>
            )}
            <p className="text-xs text-muted-foreground">
              Path on the server / container (e.g. a mounted NAS share), not your computer.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {config?.canApply && (
              <Button size="sm" onClick={handleApply} disabled={!isValid || applying} className="gap-1.5">
                {applying ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                Apply &amp; restart
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={handleGenerate} disabled={!isValid}>
              Generate .env snippet
            </Button>
            {!isValid && <span className="text-xs text-muted-foreground">Fix the highlighted field to continue.</span>}
          </div>

          {applyResult && (
            <div
              className={`flex items-start gap-2 rounded-md border p-3 text-sm ${
                applyResult.ok ? "border-primary/40 text-foreground" : "border-destructive/40 text-destructive"
              }`}
              role="status"
            >
              {applyResult.ok ? (
                <RefreshCw className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              ) : (
                <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
              )}
              <span className="break-all">{applyResult.message}</span>
            </div>
          )}

          {snippet && (
            <div className="relative">
              <pre className="overflow-x-auto rounded-md border border-border bg-muted p-3 text-xs font-mono">{snippet}</pre>
              <Button variant="ghost" size="sm" onClick={handleCopy} className="absolute right-2 top-2 gap-1.5">
                <Copy className="h-3.5 w-3.5" />
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
          )}
        </div>
      </CardContent>

      {pickerOpen && (
        <DirectoryPicker
          initialPath={fsPath || undefined}
          onSelect={p => {
            setFsPath(p);
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </Card>
  );
}
