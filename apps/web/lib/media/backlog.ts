import { apiFetch } from "@/lib/apiFetch";
import type { DerivativeProgress } from "@vault/types";

/** Current derivative backlog + rate/ETA for the persistent status strip.
 *  Null on any failure — the strip just stays hidden rather than erroring. */
export async function getDerivativeBacklog (): Promise<DerivativeProgress | null> {
  try {
    const res = await apiFetch("/api/server/backlog", { credentials: "include" });
    if (!res.ok) return null;
    return (await res.json()) as DerivativeProgress;
  } catch {
    return null;
  }
}
