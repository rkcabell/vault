import type { Queue } from "bullmq";

/** Filter that selects which media to delete (mirrors the GET/DELETE list filters,
 *  minus pagination). An empty object means "every media item this user owns". */
export type DeleteJobFilters = {
  queryText?: string | null;
  tags?: string[];
  excludeTags?: string[];
  thumbState?: "PENDING" | "READY" | "ERROR" | "FAILED" | "UNSUPPORTED";
  textState?: "PENDING" | "READY" | "ERROR" | "FAILED" | "UNSUPPORTED";
  excludeUnpacked?: boolean;
  /** "only" restricts the job to items whose source file has vanished — the
   *  library's "Missing files" view. This MUST be carried through: without it a
   *  select-all delete launched from that view would match the whole library. */
  missing?: "only";
};

/**
 * A request to delete media in the background. The actual set-based delete +
 * thumbnail unlinks run in the worker so a huge selection never blocks the HTTP
 * request or starves the Prisma pool (see worker/deleteWorker.ts).
 *
 * Exactly one source is used:
 *   - `ids`     — hand-picked multi-select. The list is bounded by what a user
 *                 can select, so carrying it in job data is fine.
 *   - `filters` — "select all (matching a filter)". The worker re-selects rows
 *                 in chunks, keeping memory flat for unbounded libraries. An
 *                 absent/empty filter object deletes every item the user owns.
 */
export type DeleteJobData = {
  userId: string;
  ids?: string[];
  filters?: DeleteJobFilters;
};

/** Live progress attached to the BullMQ job, polled by GET /api/media/delete/status. */
export type DeleteJobProgress = {
  /** Total to delete: ids.length, or the up-front count for a filter job. */
  total: number;
  deleted: number;
  /** Chunks whose delete rejected (left for a later retry/reconcile). */
  failed: number;
  /** True when stopped early by an abort (see lib/media/deleteAbort). */
  aborted?: boolean;
};

export const DELETE_QUEUE = process.env.DELETE_QUEUE ?? "delete_queue";

export async function enqueueDelete (queue: Queue<DeleteJobData>, job: DeleteJobData): Promise<string> {
  // Unlike index (one scan per root), a user can fire several distinct deletes;
  // a timestamp keeps each jobId unique. The userId prefix gates status reads.
  const jobId = `delete-${job.userId}-${Date.now()}`;

  await queue.add("delete", job, {
    jobId,
    attempts: 1, // a partial delete is resumable by re-running; don't auto-retry
    removeOnComplete: { age: 3600 }, // keep an hour so the UI can read final counts
    removeOnFail: { age: 3600 },
  });
  return jobId;
}
