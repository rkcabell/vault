import { apiFetch } from "@/lib/apiFetch";

/** Outstanding work in one queue. Null when that queue could not be read. */
export type QueueDepth = {
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  /** waiting + active + delayed — what "still to do" means on the panel. */
  pending: number;
};

export type JobQueuesState = {
  queues: Record<string, QueueDepth | null>;
  derivativesPaused: boolean;
  /** False when DERIVATIVE_FEED_ENABLED=false — a deploy-time switch Resume
   *  cannot undo, so the UI has to say so rather than offer a dead button. */
  feederEnabled: boolean;
};

/** Display order and labels. Producers first, then the derivative queues that
 *  carry the volume, then the control-plane ones. */
export const QUEUE_LABELS: [key: string, label: string][] = [
  ["index", "Indexing"],
  ["reconcile", "Checking for changes"],
  ["thumb", "Thumbnails"],
  ["text", "Text extraction"],
  ["ocr", "OCR (scans)"],
  ["hash", "Hashing"],
  ["unpack", "Archives"],
  ["organize", "Tag Organizer"],
  ["delete", "Deleting"],
];

export async function getJobQueues (): Promise<JobQueuesState | null> {
  try {
    const res = await apiFetch("/api/jobs/queues", { credentials: "include" });
    if (!res.ok) return null;
    return (await res.json()) as JobQueuesState;
  } catch {
    return null;
  }
}

async function post (path: string, body?: unknown): Promise<boolean> {
  try {
    const res = await apiFetch(path, {
      method: "POST",
      credentials: "include",
      ...(body === undefined ? {} : {
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Drops dead BullMQ records. Media rows in a terminal state are untouched. */
export const clearFailedJobs = (queue?: string) =>
  post("/api/jobs/failed/clear", queue ? { queue } : {});

/** Stop the directory walk and drop queued sweeps. Derivatives keep running. */
export const cancelScan = () => post("/api/jobs/cancel-scan");

/** Cancel the scan *and* pause the derivative feeder. */
export const stopAllProcessing = () => post("/api/jobs/stop-all");

export const resumeProcessing = () => post("/api/jobs/resume");
