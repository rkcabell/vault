import { stat } from "node:fs/promises";
import type { Queue } from "bullmq";
import {
  enqueueIndex,
  type IndexJobData,
  type IndexJobProgress,
} from "../../queues/enqueueIndex.js";
import {
  isUnderAllowedRoot,
  PathNotAllowedError,
} from "../../lib/media/indexRoots.js";
import path from "node:path";

type IndexServiceDeps = {
  indexQueue: Queue<IndexJobData>;
  logger: { info: (obj: object, msg: string) => void };
};

export type StartIndexInput = {
  path: string;
  recursive: boolean;
  ignoreHidden: boolean;
  blacklistExtensions: string[];
  excludeFolders: string[];
  skipNonContent: boolean;
};

export type StartIndexResult =
  | { ok: true; jobId: string }
  | { ok: false; reason: "disabled" | "not_allowed" | "not_found" | "not_dir" };

export type IndexStatus = {
  jobId: string;
  state: string;
  done: boolean;
  aborted: boolean;
  scanned: number;
  indexed: number;
  skipped: number;
  filtered: number;
};

/**
 * Drives in-place indexing: validates a server-side directory against the
 * allow-list, enqueues a scan job, and reports its progress. The actual walk +
 * row creation happens in the index worker (see worker/indexWorker.ts).
 */
export function createIndexService (deps: IndexServiceDeps) {
  const startIndex = async (userId: string, input: StartIndexInput, allowedRoots: string[]): Promise<StartIndexResult> => {
    if (allowedRoots.length === 0) return { ok: false, reason: "disabled" };

    const requested = path.resolve(input.path);
    if (!isUnderAllowedRoot(requested, allowedRoots)) {
      return { ok: false, reason: "not_allowed" };
    }

    let st;
    try {
      st = await stat(requested);
    } catch {
      return { ok: false, reason: "not_found" };
    }
    if (!st.isDirectory()) return { ok: false, reason: "not_dir" };

    const jobId = await enqueueIndex(deps.indexQueue, {
      userId,
      rootPath: requested,
      recursive: input.recursive,
      ignoreHidden: input.ignoreHidden,
      allowedRoots,
      blacklistExtensions: input.blacklistExtensions,
      excludeFolders: input.excludeFolders,
      skipNonContent: input.skipNonContent,
    });
    deps.logger.info({ userId, rootPath: requested, jobId }, "index scan enqueued");
    return { ok: true, jobId };
  };

  // Map a BullMQ job to the wire status. Progress is updated during the walk;
  // returnvalue holds the final counts once the job completes.
  const toStatus = async (job: NonNullable<Awaited<ReturnType<typeof deps.indexQueue.getJob>>>): Promise<IndexStatus> => {
    const state = await job.getState();
    const live = (typeof job.progress === "object" ? job.progress : null) as IndexJobProgress | null;
    const final = (job.returnvalue ?? null) as IndexJobProgress | null;
    const counts = final ?? live ?? { scanned: 0, indexed: 0, skipped: 0, filtered: 0 };

    return {
      jobId: job.id ?? "",
      state,
      done: state === "completed",
      aborted: counts.aborted ?? false,
      scanned: counts.scanned,
      indexed: counts.indexed,
      skipped: counts.skipped,
      filtered: counts.filtered ?? 0,
    };
  };

  /**
   * Read a scan job's live progress. Only the owning user may read their job —
   * the jobId embeds the userId, checked here. Returns null when unknown.
   */
  const getStatus = async (userId: string, jobId: string): Promise<IndexStatus | null> => {
    if (!jobId.startsWith(`index-${userId}-`)) return null;
    const job = await deps.indexQueue.getJob(jobId);
    if (!job) return null;
    return toStatus(job);
  };

  /**
   * Find this user's in-flight scan (if any) so the UI can re-attach after a
   * reload without remembering the jobId. Scans only the non-terminal states;
   * returns the first job whose id is owned by the user, else null.
   */
  const getActive = async (userId: string): Promise<IndexStatus | null> => {
    const jobs = await deps.indexQueue.getJobs(["active", "waiting", "delayed"]);
    const prefix = `index-${userId}-`;
    const mine = jobs.find(j => (j.id ?? "").startsWith(prefix));
    return mine ? toStatus(mine) : null;
  };

  return { startIndex, getStatus, getActive, PathNotAllowedError };
}
