import React from "react";
import { Card, CardContent } from "@/components/ui/Card";
import { cn } from "@/lib/utils";

export type ServiceStatus = "checking" | "healthy" | "degraded" | "unreachable" | "pending";

const DOT_COLOR: Record<ServiceStatus, string> = {
  healthy:     "bg-status-healthy",
  degraded:    "bg-status-degraded",
  unreachable: "bg-destructive",
  pending:     "bg-muted-foreground/40",
  checking:    "bg-muted-foreground/40 animate-pulse",
};

const TEXT_COLOR: Record<ServiceStatus, string> = {
  healthy:     "text-status-healthy",
  degraded:    "text-status-degraded",
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

export function StatusDot({ status }: { status: ServiceStatus }) {
  return (
    <span className={cn("inline-block h-2 w-2 shrink-0 rounded-full", DOT_COLOR[status])} />
  );
}

export function StatusText({ status }: { status: ServiceStatus }) {
  return (
    <span className={cn("text-sm", TEXT_COLOR[status])}>
      {STATUS_LABEL[status]}
    </span>
  );
}

export interface QueueCounts {
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
}

export interface ServiceCardProps {
  icon: React.ReactNode;
  name: string;
  detail: string;
  subDetail?: string;
  status: ServiceStatus;
  jobCounts?: QueueCounts;
  href?: string;
  linkLabel?: string;
  className?: string;
  compact?: boolean;
  fill?: boolean;
}

export function ServiceCard({ icon, name, detail, subDetail, status, jobCounts, href, linkLabel, className, compact, fill }: ServiceCardProps) {
  return (
    <Card className={className}>
      <CardContent className={cn(compact ? "pt-3 pb-3 px-3 flex flex-col gap-1.5" : "pt-5 pb-4 px-4 flex flex-col gap-3", fill && "h-full")}>
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">{icon}</span>
          <span className="font-medium text-sm">{name}</span>
        </div>
        <div className="text-xs text-muted-foreground space-y-0.5 min-h-[2.25rem]">
          <div>{detail}</div>
          {subDetail && <div>{subDetail}</div>}
          {href && linkLabel && (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-primary hover:underline"
            >
              {linkLabel}
            </a>
          )}
        </div>
        <div className={cn("flex items-center gap-2", fill && "mt-auto")}>
          <StatusDot status={status} />
          <StatusText status={status} />
        </div>
        {jobCounts && (
          <div className="mt-auto border-t pt-3 pb-1">
            <div className="grid grid-cols-3 text-center">
              <div className="flex flex-col items-center gap-0.5">
                <span className="text-2xl font-bold tabular-nums leading-none">{jobCounts.waiting}</span>
                <span className="text-xs text-muted-foreground mt-1">Waiting</span>
              </div>
              <div className="flex flex-col items-center gap-0.5">
                <span className="text-2xl font-bold tabular-nums leading-none">{jobCounts.active}</span>
                <span className="text-xs text-muted-foreground mt-1">Active</span>
              </div>
              <div className={cn("flex flex-col items-center gap-0.5", jobCounts.failed > 0 && "text-destructive")}>
                <span className="text-2xl font-bold tabular-nums leading-none">{jobCounts.failed}</span>
                <span className={cn("text-xs mt-1", jobCounts.failed > 0 ? "text-destructive" : "text-muted-foreground")}>Failed</span>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
