import { setTimeout as delay } from "node:timers/promises";
import type { StorageAdapter } from "./storage/types.js";

/**
 * Poll the storage backend until an object exists (newly uploaded objects may
 * not be immediately readable). Backend-agnostic: works for S3/MinIO and the
 * filesystem adapter via `StorageAdapter.objectExists`.
 *
 * Errors from a single probe (transient backend failures) are swallowed and
 * retried, matching the original lenient behavior — only a genuine "still
 * absent after maxTries" returns false.
 */
export async function waitUntilObjectExists (
  storage: StorageAdapter,
  bucket: string,
  key: string,
  opts?: { maxTries?: number; baseDelayMs?: number; sleep?: (ms: number) => Promise<unknown> },
): Promise<boolean> {
  const maxTries = opts?.maxTries ?? 4;
  const baseDelayMs = opts?.baseDelayMs ?? 1000;
  const sleep = opts?.sleep ?? delay;

  for (let i = 0; i < maxTries; i++) {
    try {
      if (await storage.objectExists({ bucket, key })) return true;
    } catch {
      // transient backend error — fall through to retry
    }
    await sleep(baseDelayMs * (i + 1));
  }
  return false;
}
