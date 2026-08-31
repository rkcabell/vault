import { apiFetch } from "@/lib/apiFetch";
import type { SidecarExportResult, SidecarStatus } from "@vault/types";

async function failure (res: Response, fallback: string): Promise<Error> {
  try {
    const data = await res.json();
    return new Error(data?.message || data?.error || fallback);
  } catch {
    return new Error(fallback);
  }
}

export async function getSidecarStatus (): Promise<SidecarStatus | null> {
  try {
    const res = await apiFetch("/api/sidecars", { credentials: "include" });
    if (!res.ok) return null;
    return (await res.json()) as SidecarStatus;
  } catch {
    return null;
  }
}

/** Write a snapshot now rather than waiting for the next interval. */
export async function exportSidecarSnapshot (): Promise<SidecarExportResult> {
  const res = await apiFetch("/api/sidecars/export", { method: "POST", credentials: "include" });
  if (!res.ok) throw await failure(res, `Could not write the snapshot (${res.status})`);
  return (await res.json()) as SidecarExportResult;
}

/** Start a restore. Returns as soon as it is running — poll `getSidecarStatus`
 *  for progress, since a full library takes minutes. */
export async function startSidecarRestore (): Promise<void> {
  const res = await apiFetch("/api/sidecars/restore", { method: "POST", credentials: "include" });
  if (!res.ok) throw await failure(res, `Could not start the restore (${res.status})`);
}
