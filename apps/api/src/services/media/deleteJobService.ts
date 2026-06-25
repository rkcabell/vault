import type { Queue } from "bullmq";
import {
  enqueueDelete,
  type DeleteJobData,
  type DeleteJobFilters,
  type DeleteJobProgress,
} from "../../queues/enqueueDelete.js";
import { signalDeleteAbort, type AbortRedis } from "../../lib/media/deleteAbort.js";

type DeleteJobServiceDeps = {
  deleteQueue: Queue<DeleteJobData>;
  logger: { info: (obj: object, msg: string) => void };
  /** Used to bump the delete-abort epoch (stops in-flight delete jobs). */
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

/**
 * Drives background bulk deletion: enqueues a delete job and reports its
 * progress. The actual set-based delete + thumbnail unlinks happen in the delete
 * worker (see worker/deleteWorker.ts), so a huge selection never blocks the HTTP
 * request or starves the Prisma pool.
 */
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

  // Map a BullMQ job to the wire status. Progress is updated as chunks complete;
  // returnvalue holds the final counts once the job completes.
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
   * Read a delete job's live progress. Only the owning user may read their job —
   * the jobId embeds the userId, checked here. Returns null when unknown.
   */
  const getStatus = async (userId: string, jobId: string): Promise<DeleteStatus | null> => {
    if (!jobId.startsWith(`delete-${userId}-`)) return null;
    const job = await deps.deleteQueue.getJob(jobId);
    if (!job) return null;
    return toStatus(job);
  };

  /**
   * Find this user's in-flight delete (if any) so the UI can re-attach after a
   * reload without remembering the jobId. Returns the most recent non-terminal
   * job owned by the user, else null.
   */
  const getActive = async (userId: string): Promise<DeleteStatus | null> => {
    const jobs = await deps.deleteQueue.getJobs(["active", "waiting", "delayed"]);
    const prefix = `delete-${userId}-`;
    const mine = jobs
      .filter(j => (j.id ?? "").startsWith(prefix))
      .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
    return mine[0] ? toStatus(mine[0]) : null;
  };

  /** Stop every in-flight delete that started before now (epoch bump). */
  const abort = async (): Promise<{ epoch: number } | null> => {
    if (!deps.redis) return null;
    const epoch = await signalDeleteAbort(deps.redis);
    deps.logger.info({ epoch }, "bulk delete aborted");
    return { epoch };
  };

  return { startDelete, getStatus, getActive, abort };
}
