import type { Queue } from "bullmq";
import type { OrganizeStatus } from "@vault/types";
import {
  enqueueOrganize,
  type OrganizeJobData,
  type OrganizeJobProgress,
} from "../../queues/enqueueOrganize.js";

type OrganizeJobServiceDeps = {
  organizeQueue: Queue<OrganizeJobData>;
  logger: { info: (obj: object, msg: string) => void };
};

/**
 * Drives retroactive Tag Organizer runs: enqueues an organize job and reports
 * its progress. The actual rule evaluation + tag writes happen in the organize
 * worker (see worker/organizeWorker.ts), so a large library never blocks the
 * HTTP request. Mirrors deleteJobService.
 */
export function createOrganizeJobService (deps: OrganizeJobServiceDeps) {
  const startRun = async (userId: string, dryRun: boolean): Promise<{ jobId: string }> => {
    const jobId = await enqueueOrganize(deps.organizeQueue, { userId, dryRun });
    deps.logger.info({ userId, jobId, dryRun }, "organize run enqueued");
    return { jobId };
  };

  // Map a BullMQ job to the wire status. Progress is updated per chunk;
  // returnvalue holds the final counts once the job completes.
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

  /** Read a run's live progress. Only the owning user may read their job — the
   *  jobId embeds the userId, checked here. Returns null when unknown. */
  const getStatus = async (userId: string, jobId: string): Promise<OrganizeStatus | null> => {
    if (!jobId.startsWith(`organize-${userId}-`)) return null;
    const job = await deps.organizeQueue.getJob(jobId);
    if (!job) return null;
    return toStatus(job);
  };

  /** The user's in-flight run (if any) so the UI can re-attach after a reload. */
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
