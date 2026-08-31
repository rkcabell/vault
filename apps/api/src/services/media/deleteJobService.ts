import type { Queue } from "bullmq";
import {
  enqueueDelete,
  type DeleteJobData,
  type DeleteJobFilters,
  type DeleteJobProgress,
} from "../../queues/enqueueDelete.js";
import { signalDeleteAbort, type AbortRedis } from "../../lib/media/deleteAbort.js";

/**
 * Starts bulk deletions and reports their progress. The row deletes and
 * thumbnail unlinks happen in the delete worker, so a large selection does not
 * hold the HTTP request open or exhaust the database connection pool.
 */

type DeleteJobServiceDeps = {
  deleteQueue: Queue<DeleteJobData>;
  logger: { info: (obj: object, msg: string) => void };
  /** Bumps the delete-abort epoch, which stops in-flight delete jobs. */
  redis?: Pick<AbortRedis, "incr">;
};

export type StartDeleteInput = {
  ids?: string[];
  filters?: DeleteJobFilters;
};

export type DeleteStatus = {
  jobId: string;
  state: string;
  done: boolean;
  aborted: boolean;
  total: number;
  deleted: number;
  failed: number;
};

export function createDeleteJobService (deps: DeleteJobServiceDeps) {
  const startDelete = async (userId: string, input: StartDeleteInput): Promise<{ jobId: string }> => {
    const jobId = await enqueueDelete(deps.deleteQueue, {
      userId,
      ids: input.ids,
      filters: input.filters,
    });
    deps.logger.info(
      { userId, jobId, idCount: input.ids?.length, hasFilters: !!input.filters },
      "bulk delete enqueued",
    );
    return { jobId };
  };

  // Progress stops updating as the last chunk completes. The return value holds
  // the final counts.
  const toStatus = async (
    job: NonNullable<Awaited<ReturnType<typeof deps.deleteQueue.getJob>>>,
  ): Promise<DeleteStatus> => {
    const state = await job.getState();
    const live = (typeof job.progress === "object" ? job.progress : null) as DeleteJobProgress | null;
    const final = (job.returnvalue ?? null) as DeleteJobProgress | null;
    const counts = final ?? live ?? { total: 0, deleted: 0, failed: 0 };

    return {
      jobId: job.id ?? "",
      state,
      done: state === "completed",
      aborted: counts.aborted ?? false,
      total: counts.total,
      deleted: counts.deleted,
      failed: counts.failed,
    };
  };

  /**
   * Returns a delete job's live progress, or null when the job is unknown or
   * belongs to another user. The jobId embeds the userId, which is the
   * ownership check.
   */
  const getStatus = async (userId: string, jobId: string): Promise<DeleteStatus | null> => {
    if (!jobId.startsWith(`delete-${userId}-`)) return null;
    const job = await deps.deleteQueue.getJob(jobId);
    if (!job) return null;
    return toStatus(job);
  };

  /** Returns the user's most recent unfinished delete, or null when there is none. */
  const getActive = async (userId: string): Promise<DeleteStatus | null> => {
    const jobs = await deps.deleteQueue.getJobs(["active", "waiting", "delayed"]);
    const prefix = `delete-${userId}-`;
    const mine = jobs
      .filter(j => (j.id ?? "").startsWith(prefix))
      .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
    return mine[0] ? toStatus(mine[0]) : null;
  };

  /** Stops every in-flight delete that started before now. Returns null when no
   *  Redis connection was provided. */
  const abort = async (): Promise<{ epoch: number } | null> => {
    if (!deps.redis) return null;
    const epoch = await signalDeleteAbort(deps.redis);
    deps.logger.info({ epoch }, "bulk delete aborted");
    return { epoch };
  };

  return { startDelete, getStatus, getActive, abort };
}
