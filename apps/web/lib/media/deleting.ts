import { apiFetch } from "@/lib/apiFetch";

/** Live progress of a background bulk-delete job. */
export type DeleteStatus = {
  jobId: string;
  state: string;
  done: boolean;
  aborted: boolean;
  total: number;
  deleted: number;
  failed: number;
};

/** Filter selecting which media to delete (mirrors the library list filters). */
export type DeleteFilters = {
  q?: string;
  tags?: string;          // comma-separated
  excludeTags?: string;   // comma-separated
  thumbState?: "PENDING" | "READY" | "ERROR" | "FAILED" | "UNSUPPORTED";
  textState?: "PENDING" | "READY" | "ERROR" | "FAILED" | "UNSUPPORTED";
  excludeUnpacked?: boolean;
};

/**
 * Start a background bulk delete. Pass `ids` for a hand-picked multi-select, or
 * `query` (a pre-built filter query string from buildDeleteAllQuery) to delete
 * everything matching. Returns the jobId to poll. Throws if the API rejects it.
 */
export async function startBulkDelete (
  input: { ids: string[] } | { query: string },
): Promise<{ jobId: string }> {
  const isIds = "ids" in input;
  const url = isIds ? "/api/media" : `/api/media${input.query ? `?${input.query}` : ""}`;
  const res = await apiFetch(url, {
    method: "DELETE",
    credentials: "include",
    ...(isIds
      ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: input.ids }) }
      : {}),
  });
  if (res.status !== 202) {
    let msg = `Delete failed to start (${res.status})`;
    try {
      const data = await res.json();
      msg = data?.message || data?.error || msg;
    } catch {}
    throw new Error(msg);
  }
  return (await res.json()) as { jobId: string };
}

export async function getDeleteStatus (jobId: string): Promise<DeleteStatus | null> {
  try {
    const res = await apiFetch(`/api/media/delete/status?jobId=${encodeURIComponent(jobId)}`, {
      credentials: "include",
    });
    if (!res.ok) return null;
    return (await res.json()) as DeleteStatus;
  } catch {
    return null;
  }
}

/** The user's in-flight delete, if any — lets the UI re-attach after a reload. */
export async function getActiveDelete (): Promise<DeleteStatus | null> {
  try {
    const res = await apiFetch("/api/media/delete/active", { credentials: "include" });
    if (!res.ok) return null;
    const data = (await res.json()) as { status: DeleteStatus | null };
    return data.status;
  } catch {
    return null;
  }
}

/** Stop the in-flight bulk delete(s). Best-effort. */
export async function abortBulkDelete (): Promise<void> {
  try {
    await apiFetch("/api/media/delete/abort", { method: "POST", credentials: "include" });
  } catch {
    // best-effort; the indicator will reflect the next polled status
  }
}
