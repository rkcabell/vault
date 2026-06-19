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
};

export type StartIndexResult =
  | { ok: true; jobId: string }
  | { ok: false; reason: "disabled" | "not_allowed" | "not_found" | "not_dir" };

export type IndexStatus = {
  jobId: string;
  state: string;
  done: boolean;
  scanned: number;
  indexed: number;
  skipped: number;
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
    });
    deps.logger.info({ userId, rootPath: requested, jobId }, "index scan enqueued");
    return { ok: true, jobId };
  };

  /**
   * Read a scan job's live progress. Only the owning user may read their job —
   * the jobId embeds the userId, checked here. Returns null when unknown.
   */
  const getStatus = async (userId: string, jobId: string): Promise<IndexStatus | null> => {
    if (!jobId.startsWith(`index-${userId}-`)) return null;
    const job = await deps.indexQueue.getJob(jobId);
    if (!job) return null;

    const state = await job.getState();
    // Progress is updated during the walk; returnvalue holds the final counts.
    const live = (typeof job.progress === "object" ? job.progress : null) as IndexJobProgress | null;
    const final = (job.returnvalue ?? null) as IndexJobProgress | null;
    const counts = final ?? live ?? { scanned: 0, indexed: 0, skipped: 0 };

    return {
      jobId,
      state,
      done: state === "completed",
      scanned: counts.scanned,
      indexed: counts.indexed,
      skipped: counts.skipped,
    };
  };

  return { startIndex, getStatus, PathNotAllowedError };
}
