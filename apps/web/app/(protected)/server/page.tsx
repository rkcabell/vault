"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/Card";
import { Badge } from "@/ui/Badge";
import { Button } from "@/ui/Button";
import { Input } from "@/components/ui/Input";
import { cn } from "@/lib/utils";
import {
  Activity,
  Database,
  HardDrive,
  Power,
  RefreshCw,
  RotateCcw,
  ServerCrash,
  Cpu,
  Layers,
} from "lucide-react";


//TODO: Restart and shutdown takes too long
//Todo: revisit restart and shutdown functionality on dev, prod, and docker modes
//Todo: add more server info — CPU/RAM usage

type ServiceStatus = "checking" | "healthy" | "degraded" | "unreachable" | "pending";

const DOT_COLOR: Record<ServiceStatus, string> = {
  healthy:     "bg-green-500",
  degraded:    "bg-yellow-500",
  unreachable: "bg-destructive",
  pending:     "bg-muted-foreground/40",
  checking:    "bg-muted-foreground/40 animate-pulse",
};

const TEXT_COLOR: Record<ServiceStatus, string> = {
  healthy:     "text-green-500",
  degraded:    "text-yellow-500",
  unreachable: "text-destructive",
  pending:     "text-muted-foreground",
  checking:    "text-muted-foreground",
};

const STATUS_LABEL: Record<ServiceStatus, string> = {
  healthy:     "Healthy",
  degraded:    "Degraded",
  unreachable: "Unreachable",
  pending:     "Pending",
  checking:    "Checking…",
};

function StatusDot({ status }: { status: ServiceStatus }) {
  return (
    <span className={cn("inline-block h-2 w-2 shrink-0 rounded-full", DOT_COLOR[status])} />
  );
}

function StatusText({ status }: { status: ServiceStatus }) {
  return (
    <span className={cn("text-sm", TEXT_COLOR[status])}>
      {STATUS_LABEL[status]}
    </span>
  );
}

interface ServiceCardProps {
  icon: React.ReactNode;
  name: string;
  detail: string;
  endpoint?: string;
  status: ServiceStatus;
}

function ServiceCard({ icon, name, detail, endpoint, status }: ServiceCardProps) {
  return (
    <Card>
      <CardContent className="pt-5 pb-4 px-4 flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">{icon}</span>
          <span className="font-medium text-sm">{name}</span>
        </div>
        <div className="text-xs text-muted-foreground space-y-0.5">
          <div>{detail}</div>
          {endpoint && <div className="font-mono">{endpoint}</div>}
        </div>
        <div className="flex items-center gap-2">
          <StatusDot status={status} />
          <StatusText status={status} />
        </div>
      </CardContent>
    </Card>
  );
}

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return "< 1m";
}

const isDev = process.env.NEXT_PUBLIC_NODE_ENV !== "production";

export default function ServerPage() {
  const [api,   setApi]   = useState<ServiceStatus>("checking");
  const [db,    setDb]    = useState<ServiceStatus>("checking");
  const [redis, setRedis] = useState<ServiceStatus>("checking");
  const [minio, setMinio] = useState<ServiceStatus>("checking");

  const [ocrWorker,   setOcrWorker]   = useState<ServiceStatus>("checking");
  const [thumbWorker, setThumbWorker] = useState<ServiceStatus>("checking");

  const [lastChecked,    setLastChecked]    = useState<Date | null>(null);
  const [isRefreshing,   setIsRefreshing]   = useState(false);
  const [uptimeSeconds,  setUptimeSeconds]  = useState<number | null>(null);
  const [corsOrigin,     setCorsOrigin]     = useState("");
  const [isShuttingDown, setIsShuttingDown] = useState(false);
  const [confirmAction,  setConfirmAction]  = useState<"restart" | "shutdown" | null>(null);

  const [webPort, setWebPort] = useState("3000");
  const [apiPort, setApiPort] = useState("8000");

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [isRestarting, setIsRestarting] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    if (!isRestarting) { setElapsedSeconds(0); return; }
    const timer = setInterval(() => setElapsedSeconds(s => s + 1), 1000);
    return () => clearInterval(timer);
  }, [isRestarting]);

  const poll = useCallback(async () => {
    setIsRefreshing(true);
    const [liveness, readiness] = await Promise.allSettled([
      fetch("/health/healthz").then(r => r.ok),
      fetch("/health/readyz").then(async r => ({ ok: r.ok, body: await r.json().catch(() => null) })),
    ]);

    setApi(liveness.status === "fulfilled" && liveness.value ? "healthy" : "unreachable");

    if (readiness.status === "fulfilled") {
      const { ok, body } = readiness.value as { ok: boolean; body: { services?: Record<string, string> } | null };
      const svc = body?.services;
      setDb(    svc?.db    === "healthy" ? "healthy" : svc?.db    === "degraded" ? "degraded" : ok ? "healthy" : "unreachable");
      setRedis( svc?.redis === "healthy" ? "healthy" : svc?.redis === "degraded" ? "degraded" : "unreachable");
      setMinio( svc?.s3    === "healthy" ? "healthy" : svc?.s3    === "degraded" ? "degraded" : "unreachable");
    } else {
      setDb("unreachable");
      setRedis("unreachable");
      setMinio("unreachable");
    }

    setLastChecked(new Date());
    setIsRefreshing(false);
  }, []);

  const loadServerInfo = useCallback(async () => {
    const [statusRes, workersRes] = await Promise.allSettled([
      fetch("/api/server/status").then(r => r.json()),
      fetch("/api/server/workers").then(r => r.json()),
    ]);

    if (statusRes.status === "fulfilled") {
      const s = statusRes.value as { apiPort: number; corsOrigin: string; uptimeSeconds: number };
      setApiPort(String(s.apiPort));
      setCorsOrigin(s.corsOrigin ?? "");
      setUptimeSeconds(s.uptimeSeconds ?? null);
    }
    if (workersRes.status === "fulfilled") {
      const w = workersRes.value as { ocr: { active: boolean }; thumb: { active: boolean } };
      setOcrWorker(  w.ocr?.active   ? "healthy" : "unreachable");
      setThumbWorker(w.thumb?.active ? "healthy" : "unreachable");
    }
  }, []);

  useEffect(() => {
    void poll();
    void loadServerInfo();
    intervalRef.current = setInterval(() => { void poll(); }, 30_000);
    return () => {
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [poll, loadServerInfo]);

  useEffect(() => {
    if (!isRestarting) return;
    const MAX_ATTEMPTS = 30; // 30 × 10 s = 5 min max (migration + cold start can take ~2 min)
    let attempts = 0;
    let cancelled = false;
    let reconnect: ReturnType<typeof setInterval>;

    // Wait 5 s before the first check — server is still shutting down
    const initial = setTimeout(() => {
      if (cancelled) return;
      reconnect = setInterval(async () => {
        if (cancelled) return;
        attempts += 1;
        try {
          // Use readyz (not healthz) — it confirms DB/Redis/S3 are connected,
          // not just that the process is alive. Avoids reloading into a half-ready server.
          const res = await fetch("/health/readyz");
          if (res.ok && !cancelled) {
            clearInterval(reconnect);
            window.location.reload();
            return;
          }
        } catch { /* still down — keep looping */ }
        if (attempts >= MAX_ATTEMPTS && !cancelled) {
          clearInterval(reconnect);
          setIsRestarting(false);
          setIsShuttingDown(false);
        }
      }, 10_000);
    }, 5_000);

    return () => {
      cancelled = true;
      clearTimeout(initial);
      clearInterval(reconnect);
    };
  }, [isRestarting]);

  const handleServerAction = async (action: "restart" | "shutdown") => {
    setConfirmAction(null);
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (action === "restart") setIsRestarting(true);
    setIsShuttingDown(true);
    await fetch(`/api/server/${action}`, { method: "POST" }).catch(() => null);
  };

  const handleApplyConfig = async () => {
    setConfirmAction(null);
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    setIsRestarting(true);
    setIsShuttingDown(true);
    await fetch("/api/server/config", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiPort: Number(apiPort) }),
    }).catch(() => null);
  };

  const overviewServices: { name: string; status: ServiceStatus }[] = [
    { name: "API",      status: api   },
    { name: "Database", status: db    },
    { name: "Redis",    status: redis },
    { name: "MinIO",    status: minio },
  ];

  return (
    <>
      {/* Shutdown/restart overlay */}
      {isShuttingDown && (
        <div className={`fixed inset-0 z-50 flex items-center justify-center crt-screen ${isRestarting ? "mode-restart" : "mode-shutdown"}`}>
          <style>{`
            .crt-screen {
              background: rgba(0, 4, 0, 0.97);
              background-image: repeating-linear-gradient(
                0deg, transparent, transparent 2px,
                rgba(0, 0, 0, 0.12) 2px, rgba(0, 0, 0, 0.12) 4px
              );
              --c0: rgb(74, 222, 128);
              --c1: rgba(74, 222, 128, 0.4);
              --c2: rgba(134, 239, 172, 0.5);
            }
            .crt-screen.mode-shutdown {
              --c0: rgb(248, 113, 113);
              --c1: rgba(248, 113, 113, 0.4);
              --c2: rgba(252, 165, 165, 0.5);
            }

            /* LOADER 1 — RGB chromatic aberration on title */
            .gl-title {
              font-weight: 900;
              font-family: monospace;
              font-size: 52px;
              letter-spacing: 0.35em;
              color: #f1f5f9;
              text-shadow: 0 0 0 rgb(255, 0, 0), 0 0 0 rgb(0, 255, 0), 0 0 0 rgb(0, 0, 255);
              animation: gl-rgb 1s infinite cubic-bezier(0.5, -2000, 0.5, 2000);
            }
            .gl-title::before { content: "VAULT"; }
            @keyframes gl-rgb {
              25%, 100% {
                text-shadow:
                   0.03px -0.01px 0.01px rgb(255, 0, 0),
                   0.02px  0.02px 0      rgb(0, 255, 0),
                  -0.02px  0.02px 0      rgb(0, 0, 255);
              }
            }

            /* LOADER 2 — horizontal scan on separators */
            .gl-sep {
              font-family: monospace;
              display: inline-grid;
              font-size: 11px;
              color: var(--c1);
            }
            .gl-sep::before, .gl-sep::after {
              content: "────────────────────────────────────";
              grid-area: 1/1;
              -webkit-mask-size: 100% 3px, 100% 100%;
              -webkit-mask-repeat: no-repeat;
              -webkit-mask-composite: xor;
              mask-composite: exclude;
              animation: gl-h1 1s infinite;
            }
            .gl-sep::before { -webkit-mask-image: linear-gradient(#000 0 0), linear-gradient(#000 0 0); }
            .gl-sep::after  {
              -webkit-mask-image: linear-gradient(#000 0 0);
              animation: gl-h1 1s infinite, gl-h2 .2s infinite cubic-bezier(0.5, 200, 0.5, -200);
            }
            @keyframes gl-h1 {
              0%   { -webkit-mask-position: 0 20px, 0 0 }
              20%  { -webkit-mask-position: 0 8px,  0 0 }
              40%  { -webkit-mask-position: 0 100%, 0 0 }
              60%  { -webkit-mask-position: 0 3px,  0 0 }
              80%  { -webkit-mask-position: 0 15px, 0 0 }
              100% { -webkit-mask-position: 0 0,    0 0 }
            }
            @keyframes gl-h2 { 100% { transform: translate(0.1px); } }

            /* LOADER 4 — vertical column scan on main status */
            .gl-status {
              font-weight: bold;
              font-family: monospace;
              display: inline-grid;
              font-size: 26px;
              letter-spacing: 0.12em;
              color: var(--c0);
            }
            .gl-status::before, .gl-status::after {
              grid-area: 1/1;
              -webkit-mask-size: 1.5ch 100%, 100% 100%;
              -webkit-mask-repeat: no-repeat;
              -webkit-mask-composite: xor;
              mask-composite: exclude;
              animation: gl-v1 3s infinite;
            }
            .gl-status::before { -webkit-mask-image: linear-gradient(#000 0 0), linear-gradient(#000 0 0); }
            .gl-status::after  {
              -webkit-mask-image: linear-gradient(#000 0 0);
              animation: gl-v1 3s infinite, gl-v2 .5s infinite cubic-bezier(0.5, 200, 0.5, -200);
            }
            .mode-restart  .gl-status::before, .mode-restart  .gl-status::after { content: "RESTARTING..."; }
            .mode-shutdown .gl-status::before, .mode-shutdown .gl-status::after { content: "SHUTTING.DOWN."; }
            @keyframes gl-v1 {
              0%   { -webkit-mask-position: 0      0, 0 0 }
              20%  { -webkit-mask-position: .5ch   0, 0 0 }
              40%  { -webkit-mask-position: 100%   0, 0 0 }
              60%  { -webkit-mask-position: 4.5ch  0, 0 0 }
              80%  { -webkit-mask-position: 6.5ch  0, 0 0 }
              100% { -webkit-mask-position: 2.5ch  0, 0 0 }
            }
            @keyframes gl-v2 { 100% { transform: translateY(0.2px); } }

            /* LOADER 3 — character drop on sub-status */
            .gl-sub {
              font-family: monospace;
              white-space: pre;
              font-size: 12px;
              color: var(--c2);
            }
            .mode-restart  .gl-sub::before {
              content: "waiting for server response...";
              animation: gl-chars-r 2s infinite alternate;
            }
            .mode-shutdown .gl-sub::before {
              content: "process terminating...       ";
              animation: gl-chars-s 2s infinite alternate;
            }
            @keyframes gl-chars-r {
              0%, 15%, 75%, 100% { content: "waiting for server response..."; }
              25% { content: "wa ting for server response..."; }
              30% { content: "wait ng for server res onse..."; }
              35% { content: " aiting for server response..."; }
              40% { content: "wai ing for server  esponse..."; }
              45% { content: "waitin  for  erver response..."; }
              50% { content: "wai ing for server re ponse. ."; }
              55% { content: "waiting for s rver response. "; }
              60% { content: " ai ing for server res onse..."; }
              65% { content: "w aiting for s rver respo se..."; }
              70% { content: "waiti g f r  erver...         "; }
            }
            @keyframes gl-chars-s {
              0%, 15%, 75%, 100% { content: "process terminating...       "; }
              25% { content: "pro ess terminating...       "; }
              30% { content: "proc ss  erminating...       "; }
              35% { content: " rocess terminating...       "; }
              40% { content: "proce s  erminating...       "; }
              45% { content: "process  erminat ng. .       "; }
              50% { content: "proc ss terminati g...       "; }
              55% { content: "process  erminat ng          "; }
              60% { content: " ro ess termi ating...       "; }
              65% { content: "proce s t rminat ng...       "; }
              70% { content: "proc ss...                   "; }
            }
          `}</style>
          <div className="flex flex-col items-center gap-5">
            <div className="gl-title" />
            <div className="gl-sep" />
            <div className="gl-status" />
            <div className="gl-sep" />
            <div className="gl-sub" />
            {isRestarting && (
              <div style={{ fontFamily: "monospace", fontSize: "11px", color: "rgba(74,222,128,0.35)", letterSpacing: "0.08em" }}>
                {Math.floor(elapsedSeconds / 60)}:{String(elapsedSeconds % 60).padStart(2, "0")} elapsed
              </div>
            )}
          </div>
        </div>
      )}

      <div className="mx-auto max-w-5xl space-y-6 p-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold">Server Management</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Monitor services, inspect health, and manage server controls.
            </p>
          </div>
          <Badge variant={isDev ? "secondary" : "default"} className="text-xs px-2.5 py-1">
            {isDev ? "DEVELOPMENT" : "PRODUCTION"}
          </Badge>
        </div>

        {/* Overview + Actions row */}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-5">
          {/* System Overview */}
          <Card className="md:col-span-2">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold">System Overview</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2.5">
              {overviewServices.map(({ name, status }) => (
                <div key={name} className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">{name}</span>
                  <div className="flex items-center gap-2">
                    <StatusDot status={status} />
                    <StatusText status={status} />
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>

          {/* Quick Actions */}
          <Card className="md:col-span-3">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold">Quick Actions</CardTitle>
              {!isDev && (
                <CardDescription className="text-xs">
                  Config changes are disabled in production — use environment variables.
                </CardDescription>
              )}
            </CardHeader>
            <CardContent className="space-y-4">
              {confirmAction ? (
                <div className="space-y-3">
                  <p className="text-sm">
                    {confirmAction === "shutdown"
                      ? "Shut down the server? It will stop accepting requests."
                      : "Restart the server? It will briefly go offline."}
                  </p>
                  <div className="flex gap-2">
                    <Button
                      variant={confirmAction === "shutdown" ? "destructive" : "outline"}
                      size="sm"
                      onClick={() => { void handleServerAction(confirmAction); }}
                    >
                      Confirm {confirmAction === "shutdown" ? "Shutdown" : "Restart"}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setConfirmAction(null)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setConfirmAction("restart")}
                    disabled={isShuttingDown}
                    className="gap-1.5"
                  >
                    <RotateCcw className="h-4 w-4" />
                    Restart Server
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => setConfirmAction("shutdown")}
                    disabled={isShuttingDown}
                    className="gap-1.5"
                  >
                    <Power className="h-4 w-4" />
                    Shut Down
                  </Button>
                </div>
              )}

              <div className="flex items-center justify-between border-t pt-3">
                <div className="text-xs text-muted-foreground space-y-0.5">
                  {lastChecked && (
                    <div>Last checked: {lastChecked.toLocaleTimeString()}</div>
                  )}
                  {uptimeSeconds !== null && (
                    <div>Uptime: {formatUptime(uptimeSeconds)}</div>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => { void poll(); }}
                  disabled={isRefreshing || isShuttingDown}
                  className="gap-1.5"
                >
                  <RefreshCw className={cn("h-4 w-4", isRefreshing && "animate-spin")} />
                  Refresh Service Health
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Service Health grid */}
        <div>
          <h2 className="mb-3 text-sm font-semibold text-muted-foreground uppercase tracking-wide">
            Service Health
          </h2>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <ServiceCard
              icon={<Activity className="h-4 w-4" />}
              name="API"
              detail="Port 8000"
              endpoint="GET /health/healthz"
              status={api}
            />
            <ServiceCard
              icon={<Database className="h-4 w-4" />}
              name="Database"
              detail="PostgreSQL · 5432"
              endpoint="GET /health/readyz"
              status={db}
            />
            <ServiceCard
              icon={<ServerCrash className="h-4 w-4" />}
              name="Redis"
              detail="Port 6379"
              status={redis}
            />
            <ServiceCard
              icon={<HardDrive className="h-4 w-4" />}
              name="MinIO"
              detail="Port 9000"
              endpoint="HeadBucket"
              status={minio}
            />
          </div>
        </div>

        {/* Workers grid */}
        <div>
          <h2 className="mb-3 text-sm font-semibold text-muted-foreground uppercase tracking-wide">
            Workers
          </h2>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <ServiceCard
              icon={<Cpu className="h-4 w-4" />}
              name="OCR Worker"
              detail="Text extraction · BullMQ"
              status={ocrWorker}
            />
            <ServiceCard
              icon={<Layers className="h-4 w-4" />}
              name="Thumbnail Worker"
              detail="Image processing · BullMQ"
              status={thumbWorker}
            />
          </div>
        </div>

        {/* Configuration */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold">Configuration</CardTitle>
            <CardDescription className="text-xs">
              {isDev
                ? "API port changes write to .env and trigger a restart. Web port requires restarting the Next.js process manually."
                : "Port changes require updating environment variables and restarting via your process manager."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-end gap-4">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground" htmlFor="web-port">
                  Web Port
                </label>
                <Input
                  id="web-port"
                  type="number"
                  value={webPort}
                  onChange={e => setWebPort(e.target.value)}
                  disabled
                  title="Restart the Next.js process to change the web port"
                  className="w-28"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground" htmlFor="api-port">
                  API Port
                </label>
                <Input
                  id="api-port"
                  type="number"
                  value={apiPort}
                  onChange={e => setApiPort(e.target.value)}
                  disabled={!isDev || isShuttingDown}
                  className="w-28"
                />
              </div>
              {corsOrigin && (
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground" htmlFor="cors-origin">
                    CORS Origin
                  </label>
                  <Input
                    id="cors-origin"
                    value={corsOrigin}
                    disabled
                    className="w-56"
                  />
                </div>
              )}
              {isDev && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => { void handleApplyConfig(); }}
                  disabled={isShuttingDown}
                >
                  Apply Changes
                </Button>
              )}
            </div>
            {isDev && (
              <p className="text-xs text-muted-foreground">
                Apply writes the new port to <code className="font-mono">.env</code> and restarts the API.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
