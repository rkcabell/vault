import { apiFetch } from "@/lib/apiFetch";

/**
 * A reconciliation sweep: the bidirectional diff between the allowed folders and
 * the library. Distinct from an index scan, which only ever adds files it has
 * not seen — this one also notices deletions, moves and edits that happened
 * while Vault was not running.
 */
export type ReconcileStatus = {
  jobId: string;
  /** The root this sweep covered. */
  rootPath: string;
  state: string;
  done: boolean;
  aborted: boolean;
  /** Epoch ms, or null while still running. */
  finishedAt: number | null;
  /** Library rows checked against the disk. */
  checked: number;
  /** Files found on disk. */
  scanned: number;
  added: number;
  moved: number;
  revived: number;
  missing: number;
  changed: number;
};

export type ReconcileState = {
  active: ReconcileStatus | null;
  last: ReconcileStatus | null;
};

/** Start a sweep. Omit `path` to reconcile every configured root. */
export async function startReconcile (path?: string): Promise<{ jobIds: string[] }> {
  const res = await apiFetch("/api/media/index/reconcile", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(path ? { path } : {}),
  });
  if (!res.ok) {
    let msg = `Could not start the check (${res.status})`;
    try {
      const data = await res.json();
      msg = data?.message || data?.error || msg;
    } catch {}
    throw new Error(msg);
  }
  return (await res.json()) as { jobIds: string[] };
}

/**
 * Stop the in-flight reconcile sweep and drop any queued ones, leaving an
 * index scan (if any) running.
 */
export async function stopReconcile (): Promise<void> {
  const res = await apiFetch("/api/jobs/cancel-reconcile", { method: "POST", credentials: "include" });
  if (!res.ok) {
    let msg = `Could not stop the check (${res.status})`;
    try {
      const data = await res.json();
      msg = data?.message || data?.error || msg;
    } catch {}
    throw new Error(msg);
  }
}

/**
 * The running sweep (if any) and the most recent finished one. `null` means the
 * server could not be reached — distinct from `{ active: null, last: null }`,
 * which means the server answered "nothing has ever run".
 */
export async function getReconcileState (): Promise<ReconcileState | null> {
  try {
    const res = await apiFetch("/api/media/index/reconcile/state", { credentials: "include" });
    if (!res.ok) return null;
    return (await res.json()) as ReconcileState;
  } catch {
    return null;
  }
}
