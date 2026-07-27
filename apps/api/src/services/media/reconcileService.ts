import path from "node:path";
import type { Job, Queue } from "bullmq";
import {
  enqueueReconcile,
  reconcileJobPrefix,
  type ReconcileJobData,
  type ReconcileJobProgress,
} from "../../queues/enqueueReconcile.js";
import { isUnderAllowedRoot } from "../../lib/media/indexRoots.js";

type ReconcileServiceDeps = {
  reconcileQueue: Queue<ReconcileJobData>;
  logger: { info: (obj: object, msg: string) => void };
};

export type StartReconcileInput = {
  /** Reconcile only this root. Omitted = every configured root. */
  path?: string;
  allowedRoots: string[];
  ignoreHidden: boolean;
  blacklistExtensions: string[];
  excludeFolders: string[];
  skipNonContent: boolean;
};

export type StartReconcileResult =
  | { ok: true; jobIds: string[] }
  | { ok: false; reason: "disabled" | "not_allowed" };

export type ReconcileStatus = {
  jobId: string;
  /** The root this sweep covered, for the UI to name it. */
  rootPath: string;
  state: string;
  done: boolean;
  aborted: boolean;
  /** When the sweep finished, epoch ms; null while it is still running. */
  finishedAt: number | null;
  checked: number;
  scanned: number;
  added: number;
  moved: number;
  revived: number;
  missing: number;
  changed: number;
};

const EMPTY: ReconcileJobProgress = {
  checked: 0, scanned: 0, added: 0, moved: 0, revived: 0, missing: 0, changed: 0,
};

/**
 * Drives the reconciliation sweep: enqueues a job per indexing root and reports
 * progress plus the last completed run.
 *
 * The "last run" summary is read straight off the completed BullMQ job rather
 * than stored in Postgres — the job already holds the exact counters the sweep
 * returned, and `enqueueReconcile` retains completed jobs for weeks precisely so
 * this read works after a restart. One less table to keep in sync.
 */
export function createReconcileService (deps: ReconcileServiceDeps) {
  const startReconcile = async (
    userId: string,
    input: StartReconcileInput,
  ): Promise<StartReconcileResult> => {
    if (input.allowedRoots.length === 0) return { ok: false, reason: "disabled" };

    let roots: string[];
    if (input.path !== undefined) {
      const requested = path.resolve(input.path);
      if (!isUnderAllowedRoot(requested, input.allowedRoots)) {
        return { ok: false, reason: "not_allowed" };
      }
      roots = [requested];
    } else {
      roots = input.allowedRoots.map(r => path.resolve(r));
    }

    const jobIds: string[] = [];
    for (const rootPath of roots) {
      const jobId = await enqueueReconcile(deps.reconcileQueue, {
        userId,
        rootPath,
        allowedRoots: input.allowedRoots,
        ignoreHidden: input.ignoreHidden,
        blacklistExtensions: input.blacklistExtensions,
        excludeFolders: input.excludeFolders,
        skipNonContent: input.skipNonContent,
      });
      jobIds.push(jobId);
    }
    deps.logger.info({ userId, roots, jobIds }, "reconcile enqueued");
    return { ok: true, jobIds };
  };

  const toStatus = async (job: Job<ReconcileJobData>): Promise<ReconcileStatus> => {
    const state = await job.getState();
    const live = (typeof job.progress === "object" ? job.progress : null) as ReconcileJobProgress | null;
    const final = (job.returnvalue ?? null) as ReconcileJobProgress | null;
    // Final counters win: progress stops updating at the last tick, so a
    // completed job's returnvalue is the only place the true totals live.
    const counts = final ?? live ?? EMPTY;

    return {
      jobId: job.id ?? "",
      rootPath: job.data.rootPath,
      state,
      done: state === "completed",
      aborted: counts.aborted ?? false,
      finishedAt: job.finishedOn ?? null,
      checked: counts.checked ?? 0,
      scanned: counts.scanned ?? 0,
      added: counts.added ?? 0,
      moved: counts.moved ?? 0,
      revived: counts.revived ?? 0,
      missing: counts.missing ?? 0,
      changed: counts.changed ?? 0,
    };
  };

  /**
   * What the settings card needs in one round-trip: the sweep running right now
   * (so it can show live progress and re-attach after a reload) and the most
   * recent finished one (so it can show a summary when nothing is running).
   */
  const getState = async (
    userId: string,
  ): Promise<{ active: ReconcileStatus | null; last: ReconcileStatus | null }> => {
    const prefix = reconcileJobPrefix(userId);
    const [running, finished] = await Promise.all([
      deps.reconcileQueue.getJobs(["active", "waiting", "delayed"]),
      deps.reconcileQueue.getJobs(["completed", "failed"]),
    ]);

    // The jobId embeds the userId, so the prefix is the ownership check.
    const mineRunning = running.filter(j => (j.id ?? "").startsWith(prefix));
    const mineFinished = finished
      .filter(j => (j.id ?? "").startsWith(prefix))
      .sort((a, b) => (b.finishedOn ?? 0) - (a.finishedOn ?? 0));

    const [active, last] = await Promise.all([
      mineRunning[0] ? toStatus(mineRunning[0]) : Promise.resolve(null),
      mineFinished[0] ? toStatus(mineFinished[0]) : Promise.resolve(null),
    ]);
    return { active, last };
  };

  return { startReconcile, getState };
}
