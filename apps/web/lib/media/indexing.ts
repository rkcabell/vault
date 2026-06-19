import { apiFetch } from "@/lib/apiFetch";

/** Configured in-place indexing roots. `enabled` is false when none are set. */
export type IndexRoots = { enabled: boolean; roots: string[] };

/** Live progress of a directory scan job. */
export type IndexStatus = {
  jobId: string;
  state: string;
  done: boolean;
  scanned: number;
  indexed: number;
  skipped: number;
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
