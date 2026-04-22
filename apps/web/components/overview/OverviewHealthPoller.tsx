"use client";

import { useState, useEffect, useCallback } from "react";
import { Activity, Database, ServerCrash, HardDrive } from "lucide-react";
import { ServiceCard, type ServiceStatus } from "@/components/server/ServiceCard";

interface HealthState {
  api:   ServiceStatus;
  db:    ServiceStatus;
  redis: ServiceStatus;
  minio: ServiceStatus;
}

const CHECKING: HealthState = { api: "checking", db: "checking", redis: "checking", minio: "checking" };

export function OverviewHealthPoller() {
  const [health, setHealth] = useState<HealthState>(CHECKING);

  const poll = useCallback(async () => {
    const [liveness, readiness] = await Promise.allSettled([
      fetch("/health/healthz").then(r => r.ok),
      fetch("/health/readyz").then(async r => ({ ok: r.ok, body: await r.json().catch(() => null) })),
    ]);

    const api: ServiceStatus =
      liveness.status === "fulfilled" && liveness.value ? "healthy" : "unreachable";

    let db:    ServiceStatus = "unreachable";
    let redis: ServiceStatus = "unreachable";
    let minio: ServiceStatus = "unreachable";

    if (readiness.status === "fulfilled") {
      const { body } = readiness.value as { ok: boolean; body: { services?: Record<string, string> } | null };
      const svc = body?.services ?? {};
      db    = svc.db    === "healthy" ? "healthy" : svc.db    === "degraded" ? "degraded" : "unreachable";
      redis = svc.redis === "healthy" ? "healthy" : svc.redis === "degraded" ? "degraded" : "unreachable";
      minio = svc.s3    === "healthy" ? "healthy" : svc.s3    === "degraded" ? "degraded" : "unreachable";
    }

    setHealth({ api, db, redis, minio });
  }, []);

  useEffect(() => {
    void poll();
    const id = setInterval(poll, 30_000);
    return () => clearInterval(id);
  }, [poll]);

  return (
    <div className="flex flex-col gap-3 h-full">
      <ServiceCard icon={<Activity className="h-4 w-4" />}    name="API"      detail="Port 8000"            status={health.api}   compact fill className="flex-1" />
      <ServiceCard icon={<Database className="h-4 w-4" />}    name="Database" detail="Port 5432" subDetail="PostgreSQL" status={health.db}    compact fill className="flex-1" />
      <ServiceCard icon={<ServerCrash className="h-4 w-4" />} name="Redis"    detail="Port 6379"            status={health.redis} compact fill className="flex-1" />
      <ServiceCard icon={<HardDrive className="h-4 w-4" />}   name="MinIO"    detail="Port 9000"            status={health.minio} compact fill className="flex-1" />
    </div>
  );
}
