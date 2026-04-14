import { toast } from "@/components/ui/Toaster";

// ── Types ─────────────────────────────────────────────────────────────────────

export type BatchInitItem = {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  title?: string;
  tags?: string[];
  autoTagOnUpload?: boolean;
};

export type BatchInitResponseItem = {
  id: string;
  storageKey: string;
  putUrl: string;
};

export type BatchInitResponse = {
  items: BatchInitResponseItem[];
};

export type FailedUpload  = { id: string; message: string };
export type CompletedUpload = { fileId: string; mediaId: string };
export type UploadPlan = {
  fileId: string;
  file: File;
  contentType: string;
  init: BatchInitResponseItem;
};

// ── Constants ─────────────────────────────────────────────────────────────────

export const UPLOAD_CONCURRENCY = 5;
export const BATCH_CHUNK_SIZE   = 100;

// ── API calls ─────────────────────────────────────────────────────────────────

export async function batchInit(items: BatchInitItem[]): Promise<BatchInitResponse> {
  const res = await fetch("/api/media/batch-init", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items }),
  });

  if (!res.ok) {
    let msg = `Upload init failed (${res.status})`;
    try {
      const data = await res.json();
      msg = data?.message || data?.error || msg;
    } catch {}
    throw new Error(msg);
  }

  return (await res.json()) as BatchInitResponse;
}

export async function batchFinalize(ids: string[], autoUnpack?: boolean): Promise<void> {
  const res = await fetch("/api/media/batch-finalize", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids, ...(autoUnpack !== undefined ? { autoUnpack } : {}) }),
  });

  if (!res.ok) {
    let msg = `Upload finalize failed (${res.status})`;
    try {
      const data = await res.json();
      msg = data?.message || data?.error || msg;
    } catch {}
    throw new Error(msg);
  }
}

// ── Notifications ─────────────────────────────────────────────────────────────

export function notifyUploadStart(count: number) {
  toast(`${count} ${count === 1 ? "file" : "files"} uploading`, { variant: "default" });
}

export function notifyUploadSuccess() {
  toast("Upload complete", { variant: "success" });
}

export function notifyUploadFailures(count: number) {
  toast(`${count} ${count === 1 ? "file" : "files"} failed to upload`, {
    variant: "error",
    duration: 5000,
  });
}

// ── Upload orchestration ──────────────────────────────────────────────────────

export function getPendingFiles(files: Array<{ id: string; file: File; status: string }>) {
  return files.filter((f) => f.status === "pending");
}

export function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

/**
 * Run `fn` over every item in `items` with at most `limit` concurrent
 * executions — prevents saturating the browser connection pool when
 * uploading large batches.
 */
export async function limitConcurrent<T>(
  items: T[],
  fn: (item: T) => Promise<void>,
  limit: number,
): Promise<PromiseSettledResult<void>[]> {
  const results: PromiseSettledResult<void>[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      try {
        await fn(items[i]);
        results[i] = { status: "fulfilled", value: undefined };
      } catch (err) {
        results[i] = { status: "rejected", reason: err };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export async function uploadBatch(
  pendingFiles: UploadPlan[],
  uploadOne: (plan: UploadPlan) => Promise<void>,
): Promise<{ failed: FailedUpload[]; completed: CompletedUpload[] }> {
  const results = await limitConcurrent(pendingFiles, uploadOne, UPLOAD_CONCURRENCY);

  const failed: FailedUpload[] = [];
  const completed: CompletedUpload[] = [];
  results.forEach((r, idx) => {
    if (r.status === "rejected") {
      const id = pendingFiles[idx].fileId;
      const message = r.reason instanceof Error ? r.reason.message : "Upload failed";
      failed.push({ id, message });
      return;
    }
    const plan = pendingFiles[idx];
    completed.push({ fileId: plan.fileId, mediaId: plan.init.id });
  });

  return { failed, completed };
}

export function applyFailures(
  failed: FailedUpload[],
  updateFileStatus: (id: string, status: "error", error?: string) => void,
) {
  for (const f of failed) {
    updateFileStatus(f.id, "error", f.message);
  }
}

export function exitToLibrary(clearFiles: () => void, navigate: () => void) {
  setTimeout(() => {
    clearFiles();
    navigate();
  }, 400);
}
