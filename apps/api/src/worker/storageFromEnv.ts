import { createFsAdapter } from "../adapters/storage/fsAdapter.js";
import { parseAllowedRoots } from "../lib/media/indexRoots.js";
import type { StorageAdapter } from "../adapters/storage/types.js";

/**
 * Build the storage adapter for a standalone worker process from environment
 * variables (workers don't have access to the Fastify `app.config`). Mirrors
 * the API's `plugins/storage.ts` so workers and the API always agree on the
 * blob location.
 */
export function createWorkerStorage (): StorageAdapter {
  const basePath = process.env.STORAGE_FS_PATH || "/data/vault";
  // Workers never presign (no browser-facing URLs), so apiBaseUrl is irrelevant here.
  return createFsAdapter({ basePath });
}

/** Key namespace prefix. Inert on the filesystem backend (kept so the shared
 *  bucket-threading in services doesn't churn; removed with the key-scheme rework). */
export function workerBucket (): string {
  return process.env.STORAGE_BUCKET ?? "vault-media";
}

/**
 * Parsed INDEX_ALLOWED_ROOTS for a standalone worker — the allow-list that
 * gates reading in-place indexed sources from disk. Mirrors the API's
 * `config.indexAllowedRoots`. Empty when the feature is disabled.
 */
export function workerAllowedRoots (): string[] {
  return parseAllowedRoots(process.env.INDEX_ALLOWED_ROOTS);
}
