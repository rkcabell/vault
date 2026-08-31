/**
 * Builds what a standalone worker needs from environment variables, since a
 * worker has no Fastify instance to read settings from.
 */
import { createFsAdapter } from "../adapters/storage/fsAdapter.js";
import { parseAllowedRoots } from "../lib/media/indexRoots.js";
import type { StorageAdapter } from "../adapters/storage/types.js";

/**
 * Returns the storage the worker reads and writes derived files through.
 *
 * Must point at the same place as the API's storage plugin, or a worker writes
 * files the API cannot find.
 */
export function createWorkerStorage (): StorageAdapter {
  const basePath = process.env.STORAGE_FS_PATH || "/data/vault";
  // A worker never builds browser-facing URLs, so it needs no base URL.
  return createFsAdapter({ basePath });
}

/**
 * Returns the storage namespace name.
 *
 * The filesystem storage ignores it. It remains because service signatures
 * still take one.
 */
export function workerBucket (): string {
  return process.env.STORAGE_BUCKET ?? "vault-media";
}

/**
 * Returns the folders a worker may read files from.
 *
 * A worker checks a job's file path against this list before opening it. Empty
 * means no folder has been permitted, so nothing may be read.
 */
export function workerAllowedRoots (): string[] {
  return parseAllowedRoots(process.env.INDEX_ALLOWED_ROOTS);
}
