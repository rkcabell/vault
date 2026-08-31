import type { Queue } from "bullmq";

/**
 * Job that deletes many items in the background.
 */

/** Selects which media to delete, using the same filters as the library list.
 *  An empty object means every item the user owns. */
export type DeleteJobFilters = {
  queryText?: string | null;
  tags?: string[];
  excludeTags?: string[];
  thumbState?: "PENDING" | "READY" | "ERROR" | "FAILED" | "UNSUPPORTED";
  textState?: "PENDING" | "READY" | "ERROR" | "FAILED" | "UNSUPPORTED" | "NEEDS_OCR";
  excludeUnpacked?: boolean;
  /** "only" restricts the job to items whose source file is missing, which is
   *  the library's "Missing files" view. Carrying it through matters: without
   *  it, a select-all from that view matches the whole library. */
  missing?: "only";
};

/**
 * The items to delete, given one way or the other. `ids` is a hand-picked
 * selection, bounded by what a person can select. `filters` is a select-all,
 * which the worker re-runs in chunks so memory stays flat over a large library.
 */
export type DeleteJobData = {
  userId: string;
  ids?: string[];
  filters?: DeleteJobFilters;
};

/** Live progress, read back off the job by the delete status route. */
export type DeleteJobProgress = {
  /** Total to delete: ids.length, or the up-front count for a filter job. */
  total: number;
  deleted: number;
  /** Chunks whose delete failed, left for a later run to pick up. */
  failed: number;
  /** True when an abort stopped the job early. */
  aborted?: boolean;
};

export const DELETE_QUEUE = process.env.DELETE_QUEUE ?? "delete_queue";

export async function enqueueDelete (queue: Queue<DeleteJobData>, job: DeleteJobData): Promise<string> {
  // A user can start several distinct deletes, so a timestamp keeps each jobId
  // unique. The userId prefix is what gates status reads.
  const jobId = `delete-${job.userId}-${Date.now()}`;

  await queue.add("delete", job, {
    jobId,
    attempts: 1, // a partial delete is resumable by re-running; don't auto-retry
    removeOnComplete: { age: 3600 }, // keep an hour so the UI can read final counts
    removeOnFail: { age: 3600 },
  });
  return jobId;
}
