"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { Badge } from "@/ui/Badge";
import { Button } from "@/ui/Button";
import { cn } from "@/lib/utils";
import {
  Activity,
  Database,
  HardDrive,
  RefreshCw,
  ServerCrash,
  Cpu,
  Layers,
} from "lucide-react";
import { ServiceCard, StatusDot, StatusText, type ServiceStatus, type QueueCounts } from "@/components/server/ServiceCard";
import { JobsCard } from "@/components/server/JobsCard";
import { formatBytes } from "@/lib/media/utils";

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return "< 1m";
}

const isDev = process.env.NEXT_PUBLIC_NODE_ENV !== "production";

export default function ServerPage() {
  const [api,     setApi]     = useState<ServiceStatus>("checking");
  const [db,      setDb]      = useState<ServiceStatus>("checking");
  const [redis,   setRedis]   = useState<ServiceStatus>("checking");
  const [storage, setStorage] = useState<ServiceStatus>("checking");

  const [textWorker,  setTextWorker]  = useState<ServiceStatus>("checking");
  const [ocrWorker,   setOcrWorker]   = useState<ServiceStatus>("checking");
  const [thumbWorker, setThumbWorker] = useState<ServiceStatus>("checking");

  const [lastChecked,    setLastChecked]    = useState<Date | null>(null);
  const [isRefreshing,   setIsRefreshing]   = useState(false);
  const [uptimeSeconds,  setUptimeSeconds]  = useState<number | null>(null);
  const [corsOrigin,     setCorsOrigin]     = useState("");
  const [memoryMB,       setMemoryMB]       = useState<number | null>(null);
  const [dbSizeBytes,    setDbSizeBytes]    = useState<number | null>(null);
  const [textCounts,     setTextCounts]     = useState<QueueCounts | null>(null);
  const [ocrCounts,      setOcrCounts]      = useState<QueueCounts | null>(null);
  const [thumbCounts,    setThumbCounts]    = useState<QueueCounts | null>(null);
  const [storagePath,    setStoragePath]    = useState<string | null>(null);
  const [storageBytes,   setStorageBytes]   = useState<number | null>(null);
  const [storageCount,   setStorageCount]   = useState<number | null>(null);
  const webPort = "3000";
  const [apiPort, setApiPort] = useState("8000");

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
      setDb(     svc?.db      === "healthy" ? "healthy" : svc?.db      === "degraded" ? "degraded" : ok ? "healthy" : "unreachable");
      setRedis(  svc?.redis   === "healthy" ? "healthy" : svc?.redis   === "degraded" ? "degraded" : "unreachable");
      setStorage(svc?.storage === "healthy" ? "healthy" : svc?.storage === "degraded" ? "degraded" : "unreachable");
    } else {
      setDb("unreachable");
      setRedis("unreachable");
      setStorage("unreachable");
    }

    setLastChecked(new Date());
    setIsRefreshing(false);
  }, []);

  const loadServerInfo = useCallback(async () => {
    const [statusRes, workersRes, storageRes] = await Promise.allSettled([
      fetch("/api/server/status").then(r => r.json()),
      fetch("/api/server/workers").then(r => r.json()),
      fetch("/api/server/storage").then(r => r.json()),
    ]);

    if (statusRes.status === "fulfilled") {
      const s = statusRes.value as {
        apiPort: number; corsOrigin: string; uptimeSeconds: number; memoryMB: number;
        storagePath?: string | null;
      };
      setApiPort(String(s.apiPort));
      setCorsOrigin(s.corsOrigin ?? "");
      setUptimeSeconds(s.uptimeSeconds ?? null);
      setMemoryMB(s.memoryMB ?? null);
      setStoragePath(s.storagePath ?? null);
    }
    if (workersRes.status === "fulfilled") {
      const w = workersRes.value as {
        text:  { active: boolean; counts: QueueCounts };
        ocr:   { active: boolean; counts: QueueCounts };
        thumb: { active: boolean; counts: QueueCounts };
      };
      setTextWorker( w.text?.active  ? "healthy" : "unreachable");
      setOcrWorker(  w.ocr?.active   ? "healthy" : "unreachable");
      setThumbWorker(w.thumb?.active ? "healthy" : "unreachable");
      setTextCounts( w.text?.counts  ?? null);
      setOcrCounts(  w.ocr?.counts   ?? null);
      setThumbCounts(w.thumb?.counts ?? null);
    }
    if (storageRes.status === "fulfilled") {
      const st = storageRes.value as { sizeBytes: number; objectCount: number; dbSizeBytes: number };
      setStorageBytes(st.sizeBytes ?? null);
      setStorageCount(st.objectCount ?? null);
      setDbSizeBytes(st.dbSizeBytes ?? null);
    }
  }, []);

  useEffect(() => {
    void poll();
    void loadServerInfo();
    intervalRef.current = setInterval(() => { void poll(); void loadServerInfo(); }, 30_000);
    return () => {
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [poll, loadServerInfo]);

  // Refresh worker counts immediately whenever any job completes or fails,
  // rather than waiting for the 30s poll interval.
  useEffect(() => {
    const es = new EventSource("/api/media/events");
    es.addEventListener("message", () => { void loadServerInfo(); });
    return () => es.close();
  }, [loadServerInfo]);

  const overviewServices: { name: string; status: ServiceStatus }[] = [
    { name: "API",        status: api     },
    { name: "Database",   status: db      },
    { name: "Redis",      status: redis   },
    { name: "Filesystem", status: storage },
  ];

  return (
    <>
      <div className="mx-auto max-w-5xl space-y-6 p-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold">Server Dashboard</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Monitor services, inspect health, and manage server controls.
            </p>
          </div>
          {isDev && (
            <Badge variant="secondary" className="text-xs px-2.5 py-1">
              DEVELOPMENT
            </Badge>
          )}
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

          {/* System Info */}
          <Card className="md:col-span-3">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold">System Info</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-3 gap-x-4 gap-y-3">
                <div>
                  <div className="text-xs text-muted-foreground">Uptime</div>
                  <div className="text-sm font-medium mt-0.5">
                    {uptimeSeconds !== null ? formatUptime(uptimeSeconds) : "—"}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Last Checked</div>
                  <div className="text-sm font-medium mt-0.5">
                    {lastChecked ? lastChecked.toLocaleTimeString() : "—"}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Storage</div>
                  <div className="text-sm font-medium mt-0.5">
                    {storageBytes !== null ? formatBytes(storageBytes) : "—"}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Memory Usage</div>
                  <div className="text-sm font-medium mt-0.5">
                    {memoryMB !== null ? `${memoryMB} MB` : "—"}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Database</div>
                  <div className="text-sm font-medium mt-0.5">
                    {dbSizeBytes !== null ? formatBytes(dbSizeBytes) : "—"}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Objects</div>
                  <div className="text-sm font-medium mt-0.5">
                    {storageCount !== null ? storageCount.toLocaleString() : "—"}
                  </div>
                </div>
              </div>
              <div className="flex justify-end pt-1">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => { void poll(); void loadServerInfo(); }}
                  disabled={isRefreshing}
                  className="gap-1.5"
                >
                  <RefreshCw className={cn("h-4 w-4", isRefreshing && "animate-spin")} />
                  Refresh
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
              status={api}
            />
            <ServiceCard
              icon={<Database className="h-4 w-4" />}
              name="Database"
              detail="Port 5432"
              subDetail="PostgreSQL"
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
              name="Filesystem"
              detail={storagePath ?? "Filesystem path"}
              status={storage}
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
              name="Text Worker"
              detail="Native extraction · BullMQ"
              status={textWorker}
              jobCounts={textCounts ?? undefined}
            />
            <ServiceCard
              icon={<Cpu className="h-4 w-4" />}
              name="OCR Worker"
              detail="Scanned-page OCR · BullMQ"
              status={ocrWorker}
              jobCounts={ocrCounts ?? undefined}
            />
            <ServiceCard
              icon={<Layers className="h-4 w-4" />}
              name="Thumbnail Worker"
              detail="Image processing · BullMQ"
              status={thumbWorker}
              jobCounts={thumbCounts ?? undefined}
            />
          </div>
        </div>

        {/* Jobs — queue depths and the stop controls */}
        <div>
          <h2 className="mb-3 text-sm font-semibold text-muted-foreground uppercase tracking-wide">
            Jobs
          </h2>
          <JobsCard />
        </div>

        {/* Configuration */}
        <div>
          <h2 className="mb-3 text-sm font-semibold text-muted-foreground uppercase tracking-wide">
            Configuration
          </h2>
          <Card>
            <CardContent className="pt-5 pb-4 px-4">
              <div className="flex flex-wrap gap-8">
                <div>
                  <div className="text-xs text-muted-foreground">Web Port</div>
                  <div className="text-sm font-medium mt-0.5">{webPort}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">API Port</div>
                  <div className="text-sm font-medium mt-0.5">{apiPort}</div>
                </div>
                {corsOrigin && (
                  <div>
                    <div className="text-xs text-muted-foreground">Webapp URL</div>
                    <div className="text-sm font-medium font-mono mt-0.5">{corsOrigin}</div>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
