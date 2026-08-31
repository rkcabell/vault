import { apiFetch } from "@/lib/apiFetch";

/** Configured in-place indexing roots. `enabled` is false when none are set. */
export type IndexRoots = { enabled: boolean; roots: string[] };

/** Live progress of a directory scan job. */
export type IndexStatus = {
  jobId: string;
  state: string;
  done: boolean;
  aborted: boolean;
  scanned: number;
  indexed: number;
  skipped: number;
  filtered: number;
};

export async function getIndexRoots (): Promise<IndexRoots> {
  try {
    const res = await apiFetch("/api/media/index/roots", { credentials: "include" });
    if (!res.ok) return { enabled: false, roots: [] };
    return (await res.json()) as IndexRoots;
  } catch {
    return { enabled: false, roots: [] };
  }
}

export async function startIndex (path: string, recursive: boolean): Promise<{ jobId: string }> {
  const res = await apiFetch("/api/media/index", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, recursive }),
  });
  if (!res.ok) {
    let msg = `Indexing failed to start (${res.status})`;
    try {
      const data = await res.json();
      msg = data?.message || data?.error || msg;
    } catch {}
    throw new Error(msg);
  }
  return (await res.json()) as { jobId: string };
}

export async function getIndexStatus (jobId: string): Promise<IndexStatus | null> {
  try {
    const res = await apiFetch(`/api/media/index/status?jobId=${encodeURIComponent(jobId)}`, {
      credentials: "include",
    });
    if (!res.ok) return null;
    return (await res.json()) as IndexStatus;
  } catch {
    return null;
  }
}

/**
 * Stop the directory walk and drop any queued sweeps, leaving derivatives that
 * were already found to finish. Best-effort — the poll reflects the new status
 * on its next tick either way.
 */
export async function stopIndex (): Promise<void> {
  try {
    await apiFetch("/api/jobs/cancel-scan", { method: "POST", credentials: "include" });
  } catch {
    // best-effort; the poll will reflect the updated status on the next tick
  }
}

/** The user's in-flight scan, if any — lets the UI re-attach after a page reload. */
export async function getActiveIndex (): Promise<IndexStatus | null> {
  try {
    const res = await apiFetch("/api/media/index/active", { credentials: "include" });
    if (!res.ok) return null;
    const data = (await res.json()) as { status: IndexStatus | null };
    return data.status;
  } catch {
    return null;
  }
}
