"use client";

import { useState, useEffect, useCallback } from "react";
import { Activity, Database, ServerCrash, HardDrive } from "lucide-react";
import { StatusDot, StatusText, type ServiceStatus } from "@/components/server/ServiceCard";
import { OverviewWorkerPoller } from "@/components/overview/OverviewWorkerPoller";
import type { WorkerCounts } from "@/lib/api.server";

interface Props { initialWorkers: WorkerCounts | null; }

interface HealthState {
  api:   ServiceStatus;
  db:    ServiceStatus;
  redis: ServiceStatus;
  storage: ServiceStatus;
}

interface ServerInfo {
  uptimeSeconds: number | null;
  memoryMB: number | null;
}

const CHECKING: HealthState = { api: "checking", db: "checking", redis: "checking", storage: "checking" };

const SERVICES = [
  { icon: <Activity   className="h-3.5 w-3.5 text-muted-foreground" />, name: "API",      key: "api"   as const },
  { icon: <Database   className="h-3.5 w-3.5 text-muted-foreground" />, name: "Database", key: "db"    as const },
  { icon: <ServerCrash className="h-3.5 w-3.5 text-muted-foreground" />, name: "Redis",   key: "redis" as const },
  { icon: <HardDrive  className="h-3.5 w-3.5 text-muted-foreground" />, name: "Storage",  key: "storage" as const },
] as const;

function formatUptime(s: number): string {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m` : "< 1m";
}

export function OverviewHealthPoller({ initialWorkers }: Props) {
  const [health, setHealth] = useState<HealthState>(CHECKING);
  const [serverInfo, setServerInfo] = useState<ServerInfo>({ uptimeSeconds: null, memoryMB: null });

  const poll = useCallback(async () => {
    const [liveness, readiness, status] = await Promise.allSettled([
      fetch("/health/healthz").then(r => r.ok),
      fetch("/health/readyz").then(async r => ({ ok: r.ok, body: await r.json().catch(() => null) })),
      fetch("/api/server/status").then(r => r.json()),
    ]);

    const api: ServiceStatus =
      liveness.status === "fulfilled" && liveness.value ? "healthy" : "unreachable";

    let db:    ServiceStatus = "unreachable";
    let redis: ServiceStatus = "unreachable";
    let storage: ServiceStatus = "unreachable";

    if (readiness.status === "fulfilled") {
      const { body } = readiness.value as { ok: boolean; body: { services?: Record<string, string> } | null };
      const svc = body?.services ?? {};
      db    = svc.db    === "healthy" ? "healthy" : svc.db    === "degraded" ? "degraded" : "unreachable";
      redis = svc.redis === "healthy" ? "healthy" : svc.redis === "degraded" ? "degraded" : "unreachable";
      storage = svc.storage    === "healthy" ? "healthy" : svc.storage    === "degraded" ? "degraded" : "unreachable";
    }

    setHealth({ api, db, redis, storage });

    if (status.status === "fulfilled") {
      const s = status.value as { uptimeSeconds?: number; memoryMB?: number };
      setServerInfo({ uptimeSeconds: s.uptimeSeconds ?? null, memoryMB: s.memoryMB ?? null });
    }
  }, []);

  useEffect(() => {
    void poll();
    const id = setInterval(poll, 30_000);
    return () => clearInterval(id);
  }, [poll]);

  return (
    <div className="flex flex-col gap-4">

      <OverviewWorkerPoller initial={initialWorkers} />

      {(serverInfo.uptimeSeconds !== null || serverInfo.memoryMB !== null) && (
        <div className="overview-worker-card">
          <p className="overview-worker-label">Server</p>
          {serverInfo.uptimeSeconds !== null && (
            <div className="overview-system-info-row">
              <span>Uptime</span>
              <span className="overview-system-info-value">{formatUptime(serverInfo.uptimeSeconds)}</span>
            </div>
          )}
          {serverInfo.memoryMB !== null && (
            <div className="overview-system-info-row">
              <span>Memory Usage</span>
              <span className="overview-system-info-value">{serverInfo.memoryMB} MB</span>
            </div>
          )}
        </div>
      )}

      <div>
        <p className="overview-stat-label mb-2">Services</p>
        <div className="overview-service-list">
          {SERVICES.map(({ icon, name, key }) => (
            <div key={key} className="overview-service-row">
              <span className="overview-service-row-name">
                {icon}
                {name}
              </span>
              <span className="overview-service-row-status">
                <StatusDot status={health[key]} />
                <StatusText status={health[key]} />
              </span>
            </div>
          ))}
        </div>
      </div>

    </div>
  );
}
