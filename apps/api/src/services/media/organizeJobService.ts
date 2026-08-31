import type { Queue } from "bullmq";
import type { OrganizeStatus } from "@vault/types";
import {
  enqueueOrganize,
  type OrganizeJobData,
  type OrganizeJobProgress,
} from "../../queues/enqueueOrganize.js";

/**
 * Starts Tag Organizer runs over an existing library and reports their progress.
 * Rule evaluation and tag writes happen in the organize worker, so a large
 * library does not hold the HTTP request open.
 */

type OrganizeJobServiceDeps = {
  organizeQueue: Queue<OrganizeJobData>;
  logger: { info: (obj: object, msg: string) => void };
};

export function createOrganizeJobService (deps: OrganizeJobServiceDeps) {
  const startRun = async (userId: string, dryRun: boolean): Promise<{ jobId: string }> => {
    const jobId = await enqueueOrganize(deps.organizeQueue, { userId, dryRun });
    deps.logger.info({ userId, jobId, dryRun }, "organize run enqueued");
    return { jobId };
  };

  // Progress stops updating at the run's last chunk. The return value holds the
  // final counts.
  const toStatus = async (
    job: NonNullable<Awaited<ReturnType<typeof deps.organizeQueue.getJob>>>,
  ): Promise<OrganizeStatus> => {
    const state = await job.getState();
    const live = (typeof job.progress === "object" ? job.progress : null) as OrganizeJobProgress | null;
    const final = (job.returnvalue ?? null) as OrganizeJobProgress | null;
    const counts = final ?? live ?? {
      dryRun: false,
      total: 0,
      processed: 0,
      updated: 0,
      tagsAdded: 0,
      tagCounts: {},
    };

    return {
      jobId: job.id ?? "",
      state,
      done: state === "completed",
      dryRun: counts.dryRun,
      total: counts.total,
      processed: counts.processed,
      updated: counts.updated,
      tagsAdded: counts.tagsAdded,
      tagCounts: counts.tagCounts ?? {},
      sample: counts.sample,
    };
  };

  /** Returns a run's live progress, or null when the job is unknown or belongs to
   *  another user. The jobId embeds the userId, which is the ownership check. */
  const getStatus = async (userId: string, jobId: string): Promise<OrganizeStatus | null> => {
    if (!jobId.startsWith(`organize-${userId}-`)) return null;
    const job = await deps.organizeQueue.getJob(jobId);
    if (!job) return null;
    return toStatus(job);
  };

  /** Returns the user's still-running run, or null when there is none. */
  const getActive = async (userId: string): Promise<OrganizeStatus | null> => {
    const jobs = await deps.organizeQueue.getJobs(["active", "waiting", "delayed"]);
    const prefix = `organize-${userId}-`;
    const mine = jobs
      .filter(j => (j.id ?? "").startsWith(prefix))
      .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
    return mine[0] ? toStatus(mine[0]) : null;
  };

  return { startRun, getStatus, getActive };
}
