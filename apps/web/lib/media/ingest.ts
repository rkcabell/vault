import { toast } from "@/components/ui/Toaster";
import { apiFetch } from "@/lib/apiFetch";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Why sending files is unavailable — each needs a different fix from the user. */
export type IngestDisabledReason = "no-roots" | "not-set" | "outside-roots" | "missing";

export type IngestConfig = {
  enabled: boolean;
  /** The folder sent files land in. Null until one is chosen. */
  folderPath: string | null;
  maxBytes: number;
  reason?: IngestDisabledReason;
  message?: string;
};

export type IngestedFile = {
  id: string;
  /** Final filename on disk — differs from the sent one after a collision. */
  savedAs: string;
  renamed: boolean;
  sourcePath: string;
  sizeBytes: number;
};

export type FailedUpload = { id: string; message: string };
export type CompletedUpload = { fileId: string; media: IngestedFile };
export type UploadPlan = { fileId: string; file: File };

// ── Constants ─────────────────────────────────────────────────────────────────

export const UPLOAD_CONCURRENCY = 5;

// ── API calls ─────────────────────────────────────────────────────────────────

/** Reads through even when sending is off — the setup state renders from it. */
export async function getIngestConfig (): Promise<IngestConfig> {
  const res = await apiFetch("/api/ingest/config", { credentials: "include" });
  if (!res.ok) throw new Error(`Could not read the send-files setup (${res.status}).`);
  return (await res.json()) as IngestConfig;
}

/** Save the folder sent files land in. It must be inside an indexed folder. */
export async function setIngestFolder (
  roots: string[],
  folderPath: string,
): Promise<{ ok: boolean; message?: string }> {
  // Only these two fields travel: index-config leaves omitted ones untouched,
  // so this can't clobber exclusions edited in Settings.
  const res = await apiFetch("/api/server/index-config", {
    method: "PATCH",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ roots, ingestFolderPath: folderPath }),
  });
  const body = await res.json().catch(() => null);
  if (res.ok && body?.ok) return { ok: true };
  return { ok: false, message: body?.message ?? `Could not save the folder (${res.status}).` };
}

/**
 * Send one file. The API writes it into the chosen folder and indexes it in the
 * same request, so the response already carries the media row's id — there is
 * no separate init or finalize step.
 */
export async function ingestFile (file: File): Promise<IngestedFile> {
  const res = await apiFetch(`/api/ingest/file/${encodeURIComponent(file.name)}`, {
    method: "PUT",
    credentials: "include",
    headers: { "Content-Type": file.type || "application/octet-stream" },
    body: file,
  });

  if (!res.ok) {
    let msg = `Send failed (${res.status})`;
    try {
      const data = await res.json();
      msg = data?.message || data?.error || msg;
    } catch {}
    throw new Error(msg);
  }

  return (await res.json()) as IngestedFile;
}

/** Auto-unpack any archives among the new rows, per the user's preference. */
export async function unpackNew (ids: string[], autoUnpack?: boolean): Promise<void> {
  if (ids.length === 0) return;
  await apiFetch("/api/media/unpack-new", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids, ...(autoUnpack !== undefined ? { autoUnpack } : {}) }),
  });
}

// ── Notifications ─────────────────────────────────────────────────────────────

export function notifyUploadStart (count: number) {
  toast(`${count} ${count === 1 ? "file" : "files"} sending`, { variant: "default" });
}

export function notifyUploadSuccess (renamed: number) {
  if (renamed > 0) {
    toast(
      renamed === 1
        ? "Sent. One file was renamed — a file of that name was already there."
        : `Sent. ${renamed} files were renamed — files of those names were already there.`,
      { variant: "success", duration: 6000 },
    );
    return;
  }
  toast("Files sent", { variant: "success" });
}

export function notifyUploadFailures (count: number) {
  toast(`${count} ${count === 1 ? "file" : "files"} failed to send`, {
    variant: "error",
    duration: 5000,
  });
}

// ── Orchestration ─────────────────────────────────────────────────────────────

export function getPendingFiles (files: Array<{ id: string; file: File; status: string }>) {
  return files.filter(f => f.status === "pending");
}

/**
 * Run `fn` over every item with at most `limit` running at once — prevents
 * saturating the browser connection pool when sending a large selection.
 */
export async function limitConcurrent<T> (
  items: T[],
  fn: (item: T) => Promise<void>,
  limit: number,
): Promise<PromiseSettledResult<void>[]> {
  const results: PromiseSettledResult<void>[] = new Array(items.length);
  let next = 0;
  async function worker () {
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

/**
 * Send every pending file, collecting successes and failures separately so one
 * rejected file never fails the rest — each is its own request now.
 */
export async function uploadBatch (
  pending: UploadPlan[],
  sendOne: (plan: UploadPlan) => Promise<IngestedFile>,
): Promise<{ failed: FailedUpload[]; completed: CompletedUpload[] }> {
  const completed: CompletedUpload[] = [];
  const failed: FailedUpload[] = [];

  const results = await limitConcurrent(
    pending,
    async plan => {
      const media = await sendOne(plan);
      completed.push({ fileId: plan.fileId, media });
    },
    UPLOAD_CONCURRENCY,
  );

  results.forEach((r, idx) => {
    if (r.status !== "rejected") return;
    const message = r.reason instanceof Error ? r.reason.message : "Send failed";
    failed.push({ id: pending[idx].fileId, message });
  });

  return { failed, completed };
}

export function applyFailures (
  failed: FailedUpload[],
  updateFileStatus: (id: string, status: "error", error?: string) => void,
) {
  for (const f of failed) updateFileStatus(f.id, "error", f.message);
}

export function exitToLibrary (clearFiles: () => void, navigate: () => void) {
  setTimeout(() => {
    clearFiles();
    navigate();
  }, 400);
}
