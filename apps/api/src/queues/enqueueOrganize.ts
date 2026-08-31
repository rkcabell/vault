/**
 * Describes a request to re-apply the user's tagging rules across their whole
 * library, and hands it to the worker that carries it out.
 */
import type { Queue } from "bullmq";
import type { OrganizePreviewItem } from "@vault/types";

/**
 * A retroactive Tag Organizer run: re-evaluate the user's tag rules against
 * every media item and add whatever auto-tags are missing. `dryRun` previews
 * the changes (counts + a sample) without writing anything.
 */
export type OrganizeJobData = {
  userId: string;
  dryRun: boolean;
};

/** Live progress attached to the BullMQ job, polled by GET /api/tag-rules/run/status. */
export type OrganizeJobProgress = {
  dryRun: boolean;
  /** Total media rows to consider. */
  total: number;
  processed: number;
  /** Rows that received (or would receive) at least one new tag. */
  updated: number;
  /** Total tag applications added (or previewed). */
  tagsAdded: number;
  /** Per-tag application counts (capped — see organizeWorker). */
  tagCounts: Record<string, number>;
  /** Dry run only: sample of per-item changes. */
  sample?: OrganizePreviewItem[];
};

export const ORGANIZE_QUEUE = process.env.ORGANIZE_QUEUE ?? "organize_queue";

export async function enqueueOrganize (
  queue: Queue<OrganizeJobData>,
  job: OrganizeJobData,
): Promise<string> {
  // A user can fire several runs; a timestamp keeps each jobId unique. The
  // userId prefix gates status reads (see organizeJobService.getStatus).
  const jobId = `organize-${job.userId}-${Date.now()}`;

  await queue.add("organize", job, {
    jobId,
    attempts: 1, // a partial run is resumable by re-running; don't auto-retry
    removeOnComplete: { age: 3600 }, // keep an hour so the UI can read final counts
    removeOnFail: { age: 3600 },
  });
  return jobId;
}
