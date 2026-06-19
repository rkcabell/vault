"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch } from "@/lib/apiFetch";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { CheckCircle2, XCircle, Copy, Loader2, FolderOpen, RefreshCw, Database, HardDrive } from "lucide-react";
import { cn } from "@/lib/utils";
import { DirectoryPicker } from "./DirectoryPicker";

type Driver = "s3" | "fs";

type StorageConfig = {
  driver: Driver;
  fsPath: string | null;
  s3: {
    endpoint: string | null;
    publicEndpoint: string | null;
    region: string | null;
    bucket: string | null;
    accessKeyId: string | null;
    hasSecret: boolean;
  };
  canApply: boolean;
};

type TestResult = { ok: boolean; message: string };
type ApplyResult = { ok: boolean; message: string };

const inputClass =
  "w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const inputErrorClass = "border-destructive focus-visible:ring-destructive";

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function isAbsolutePath(value: string): boolean {
  // POSIX absolute (/data/vault) or Windows absolute (C:\data) — fs paths must be absolute.
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

type FormState = {
  driver: Driver;
  fsPath: string;
  s3Endpoint: string;
  s3PublicEndpoint: string;
  s3Region: string;
  s3AccessKey: string;
  s3Secret: string;
  s3Bucket: string;
};

const EMPTY_FORM: FormState = {
  driver: "fs",
  fsPath: "/data/vault",
  s3Endpoint: "",
  s3PublicEndpoint: "",
  s3Region: "us-east-1",
  s3AccessKey: "",
  s3Secret: "",
  s3Bucket: "vault-media",
};

/** Build a copy-ready .env snippet for the chosen backend. */
function buildEnvSnippet(form: FormState, hasSecret: boolean): string {
  if (form.driver === "fs") {
    return ["STORAGE_DRIVER=fs", `STORAGE_FS_PATH=${form.fsPath}`].join("\n");
  }
  return [
    "STORAGE_DRIVER=s3",
    `S3_ENDPOINT=${form.s3Endpoint}`,
    `S3_PUBLIC_ENDPOINT=${form.s3PublicEndpoint}`,
    `S3_ACCESS_KEY_ID=${form.s3AccessKey}`,
    `S3_SECRET_ACCESS_KEY=${form.s3Secret || (hasSecret ? "<keep existing>" : "<your-secret>")}`,
    `S3_BUCKET=${form.s3Bucket || "vault-media"}`,
  ].join("\n");
}

type FormErrors = Partial<Record<keyof FormState, string>>;

/** Client-side mirror of the API's env schema (config.ts superRefine). */
function validate(form: FormState, hasSecret: boolean): FormErrors {
  const errors: FormErrors = {};
  if (form.driver === "fs") {
    if (!form.fsPath.trim()) errors.fsPath = "Required when using the filesystem backend.";
    else if (!isAbsolutePath(form.fsPath.trim())) errors.fsPath = "Must be an absolute path (e.g. /data/vault).";
  } else {
    if (!isHttpUrl(form.s3Endpoint)) errors.s3Endpoint = "Must be a valid http(s) URL.";
    if (!isHttpUrl(form.s3PublicEndpoint)) errors.s3PublicEndpoint = "Must be a valid http(s) URL.";
    if (!form.s3AccessKey.trim()) errors.s3AccessKey = "Required.";
    // Secret may be left blank to keep the existing one.
    if (!form.s3Secret.trim() && !hasSecret) errors.s3Secret = "Required.";
  }
  return errors;
}

function Field(props: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  type?: string;
  placeholder?: string;
}) {
  const { id, label, value, onChange, error, type = "text", placeholder } = props;
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="text-sm font-medium">{label}</label>
      <input
        id={id}
        type={type}
        value={value}
        placeholder={placeholder}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={e => onChange(e.target.value)}
        className={error ? `${inputClass} ${inputErrorClass}` : inputClass}
      />
      {error && <p id={`${id}-error`} className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

export function StorageSettingsCard() {
  const [config, setConfig] = useState<StorageConfig | null>(null);
  const [loadError, setLoadError] = useState(false);

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [snippet, setSnippet] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<ApplyResult | null>(null);

  const hasSecret = config?.s3.hasSecret ?? false;

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm(prev => ({ ...prev, [key]: value }));

  useEffect(() => {
    let cancelled = false;
    apiFetch("/api/server/storage-config", { credentials: "include" })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((c: StorageConfig) => {
        if (cancelled) return;
        setConfig(c);
        // Pre-fill the form from the live config (secret is never sent — left blank).
        setForm({
          driver: c.driver === "fs" ? "fs" : "s3",
          fsPath: c.fsPath ?? "/data/vault",
          s3Endpoint: c.s3.endpoint ?? "",
          s3PublicEndpoint: c.s3.publicEndpoint ?? "",
          s3Region: c.s3.region ?? "us-east-1",
          s3AccessKey: c.s3.accessKeyId ?? "",
          s3Secret: "",
          s3Bucket: c.s3.bucket ?? "vault-media",
        });
      })
      .catch(() => !cancelled && setLoadError(true));
    return () => { cancelled = true; };
  }, []);

  const errors = useMemo(() => validate(form, hasSecret), [form, hasSecret]);
  const isValid = Object.keys(errors).length === 0;

  const handleGenerate = () => {
    if (!isValid) return;
    setSnippet(buildEnvSnippet(form, hasSecret));
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
        setTestResult({ ok: true, message: `Reachable and writable (${body.driver}, ${body.durationMs} ms).` });
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
    const switching = !!config && config.driver !== form.driver;
    const confirmMsg = switching
      ? `Switch the storage backend to "${form.driver}" and write your .env?\n\n` +
        `Existing files are NOT migrated — they stay in the current backend and will appear ` +
        `missing until you move them or switch back.`
      : "Write these storage settings to your .env?";
    if (!window.confirm(confirmMsg)) return;

    setApplying(true);
    setApplyResult(null);
    try {
      const payload =
        form.driver === "fs"
          ? { driver: "fs" as const, fsPath: form.fsPath.trim() }
          : {
              driver: "s3" as const,
              s3: {
                endpoint: form.s3Endpoint.trim(),
                publicEndpoint: form.s3PublicEndpoint.trim(),
                region: form.s3Region.trim(),
                bucket: form.s3Bucket.trim(),
                accessKeyId: form.s3AccessKey.trim(),
                // Omit when blank so the server keeps the existing secret.
                secretAccessKey: form.s3Secret.trim() || undefined,
              },
            };
      const res = await apiFetch("/api/server/storage-config", {
        method: "PATCH",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => null);
      if (res.ok && body?.ok) {
        setApplyResult({
          ok: true,
          message: `Saved to ${body.envPath}. Restart Vault to switch to "${body.driver}" (stop vaultdev, then run it again).`,
        });
      } else {
        setApplyResult({ ok: false, message: body?.message ?? `Failed to write env (${res.status}).` });
      }
    } catch (err) {
      setApplyResult({ ok: false, message: err instanceof Error ? err.message : "Network error" });
    } finally {
      setApplying(false);
    }
  }, [form, isValid, config]);

  const activeLabel = config?.driver === "fs" ? "Filesystem" : "Object store (S3)";
  const activeLocation = config?.driver === "fs" ? config?.fsPath : config?.s3.publicEndpoint;

  return (
    <Card>
      <CardHeader className="pb-4">
        <CardTitle>Storage</CardTitle>
        <CardDescription className="mt-1">
          Where Vault stores file originals and thumbnails.
        </CardDescription>
      </CardHeader>
      <CardContent className="px-6 pb-6 pt-0 space-y-6">
        {/* Active backend (read-only) */}
        <div className="flex items-start justify-between gap-4 rounded-lg border border-border p-3">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">Active backend</span>
              {config ? (
                <Badge variant="secondary">{activeLabel}</Badge>
              ) : loadError ? (
                <Badge variant="destructive">Unknown</Badge>
              ) : (
                <Badge variant="outline">Loading…</Badge>
              )}
            </div>
            {activeLocation && (
              <p className="text-xs text-muted-foreground font-mono break-all">{activeLocation}</p>
            )}
            <p className="text-xs text-muted-foreground">
              The currently running backend. Changes below take effect after a restart.
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
            <h3 className="text-sm font-medium">Change backend</h3>
            <p className="text-xs text-muted-foreground">
              {config?.canApply
                ? "Apply writes these values to your .env; restart Vault to switch. Or copy the snippet to apply manually."
                : "In production the env is managed by your deployment — copy the snippet and apply it there, then restart."}
            </p>
          </div>

          {/* Backend is the primary choice that drives this whole panel — render
              it as a prominent segmented control, not a field that blends in. */}
          <div className="space-y-2">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Storage backend
            </span>
            <div role="radiogroup" aria-label="Storage backend" className="grid grid-cols-2 gap-3">
              {([
                { value: "s3", title: "Object store", subtitle: "S3 / MinIO", Icon: Database },
                { value: "fs", title: "Filesystem", subtitle: "Local disk / NAS", Icon: HardDrive },
              ] as const).map(({ value, title, subtitle, Icon }) => {
                const active = form.driver === value;
                return (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => set("driver", value)}
                    className={cn(
                      "flex items-center gap-3 rounded-lg border-2 p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      active
                        ? "border-primary bg-primary/10 ring-1 ring-primary"
                        : "border-border bg-card hover:border-muted-foreground/40 hover:bg-accent",
                    )}
                  >
                    <Icon className={cn("h-6 w-6 shrink-0", active ? "text-primary" : "text-muted-foreground")} />
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold">{title}</span>
                      <span className="block truncate text-xs text-muted-foreground">{subtitle}</span>
                    </span>
                    {active && <CheckCircle2 className="ml-auto h-4 w-4 shrink-0 text-primary" />}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Settings for the selected backend — secondary to the choice above. */}
          {form.driver === "fs" ? (
            <div className="space-y-1">
              <label htmlFor="storage-fs-path" className="text-sm font-medium">
                Storage path (STORAGE_FS_PATH)
              </label>
              <div className="flex gap-2">
                <input
                  id="storage-fs-path"
                  type="text"
                  value={form.fsPath}
                  placeholder="/data/vault"
                  aria-invalid={errors.fsPath ? true : undefined}
                  aria-describedby={errors.fsPath ? "storage-fs-path-error" : undefined}
                  onChange={e => set("fsPath", e.target.value)}
                  className={errors.fsPath ? `${inputClass} ${inputErrorClass}` : inputClass}
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
              {errors.fsPath && (
                <p id="storage-fs-path-error" className="text-xs text-destructive">{errors.fsPath}</p>
              )}
              <p className="text-xs text-muted-foreground">
                Path on the server / container (e.g. a mounted NAS share), not your computer.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field id="s3-endpoint" label="S3_ENDPOINT" value={form.s3Endpoint} onChange={v => set("s3Endpoint", v)} error={errors.s3Endpoint} placeholder="http://minio:9000" />
              <Field id="s3-public-endpoint" label="S3_PUBLIC_ENDPOINT" value={form.s3PublicEndpoint} onChange={v => set("s3PublicEndpoint", v)} error={errors.s3PublicEndpoint} placeholder="http://localhost:9000" />
              <Field id="s3-access-key" label="S3_ACCESS_KEY_ID" value={form.s3AccessKey} onChange={v => set("s3AccessKey", v)} error={errors.s3AccessKey} />
              <Field
                id="s3-secret"
                label="S3_SECRET_ACCESS_KEY"
                type="password"
                value={form.s3Secret}
                onChange={v => set("s3Secret", v)}
                error={errors.s3Secret}
                placeholder={hasSecret ? "•••••• (leave blank to keep current)" : ""}
              />
              <Field id="s3-bucket" label="S3_BUCKET (optional)" value={form.s3Bucket} onChange={v => set("s3Bucket", v)} placeholder="vault-media" />
            </div>
          )}

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
            {!isValid && <span className="text-xs text-muted-foreground">Fix the highlighted fields to continue.</span>}
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
          initialPath={form.fsPath || undefined}
          onSelect={p => {
            set("fsPath", p);
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </Card>
  );
}
