import { createS3Adapter } from "../adapters/s3Adapter.js";
import { createFsAdapter } from "../adapters/storage/fsAdapter.js";
import { s3 } from "../plugins/s3Client.js";
import type { StorageAdapter } from "../adapters/storage/types.js";

/**
 * Build the storage adapter for a standalone worker process from environment
 * variables (workers don't have access to the Fastify `app.config`). Mirrors
 * the API's `plugins/storage.ts` selection so workers and the API always agree
 * on the active backend.
 */
export function createWorkerStorage (): StorageAdapter {
  if (process.env.STORAGE_DRIVER === "fs") {
    const basePath = process.env.STORAGE_FS_PATH;
    if (!basePath) throw new Error("STORAGE_FS_PATH env var is required when STORAGE_DRIVER=fs");
    // Workers never presign (no browser-facing URLs), so apiBaseUrl is irrelevant here.
    return createFsAdapter({ basePath });
  }
  return createS3Adapter(s3);
}

/** Key namespace / S3 bucket. The fs adapter ignores it, so it has a default. */
export function workerBucket (): string {
  return process.env.S3_BUCKET ?? "vault-media";
}
