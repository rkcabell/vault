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

/**
 * Starts index scans of a folder on the server and reports their progress. A
 * requested directory is checked against the allow-list before anything is
 * enqueued. The walk and the row creation happen in the index worker.
 */

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

/** `disabled` when no indexing roots are configured. `already_running` when the
 *  user already has a scan that has not finished. */
export type StartIndexResult =
  | { ok: true; jobId: string }
  | { ok: false; reason: "disabled" | "not_allowed" | "not_found" | "not_dir" | "already_running" };

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

    // One walk per user, counting every root. `enqueueIndex` only dedupes a
    // repeat of the same root. This is a check rather than a lock: two requests
    // arriving together can both pass it.
    if (await getActive(userId)) return { ok: false, reason: "already_running" };

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

  // Progress stops updating at the walk's last tick. The return value holds the
  // final counts.
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
   * Returns a scan job's live progress, or null when the job is unknown or
   * belongs to another user. The jobId embeds the userId, which is the
   * ownership check.
   */
  const getStatus = async (userId: string, jobId: string): Promise<IndexStatus | null> => {
    if (!jobId.startsWith(`index-${userId}-`)) return null;
    const job = await deps.indexQueue.getJob(jobId);
    if (!job) return null;
    return toStatus(job);
  };

  /** Returns the user's unfinished scan, or null when there is none. */
  const getActive = async (userId: string): Promise<IndexStatus | null> => {
    const jobs = await deps.indexQueue.getJobs(["active", "waiting", "delayed"]);
    const prefix = `index-${userId}-`;
    const mine = jobs.find(j => (j.id ?? "").startsWith(prefix));
    return mine ? toStatus(mine) : null;
  };

  return { startIndex, getStatus, getActive, PathNotAllowedError };
}
