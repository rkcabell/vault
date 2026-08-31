import type { Queue } from "bullmq";

/**
 * Job that reconciles one indexing root: a two-way comparison between what the
 * library records and what is on disk. It closes the gap the watcher leaves,
 * which sees only live events, and the one an index scan leaves, which skips
 * paths that already have a row.
 *
 * Every filter below is copied from user preferences when the job is queued, so
 * a settings change mid-sweep cannot affect it, and the worker checks `rootPath`
 * against the same list the caller saw.
 */
export type ReconcileJobData = {
  userId: string;
  /** Absolute root to reconcile. Re-validated against allowedRoots in the worker. */
  rootPath: string;
  allowedRoots: string[];
  /** Skip dotfiles — mirrors the ignoreHiddenFiles preference. */
  ignoreHidden: boolean;
  /** Extensions to skip, lowercase and without the dot. */
  blacklistExtensions?: string[];
  /** Absolute folders to skip, including their subtrees. */
  excludeFolders?: string[];
  /** Skip build/dependency dirs and non-content file types. */
  skipNonContent?: boolean;
};

/**
 * Live progress, and the job's return value. The finished job is also the "last
 * run" summary the settings card shows, so these counters are worded for a
 * person to read.
 */
export type ReconcileJobProgress = {
  /** Library rows under this root that were stat'd against the disk. */
  checked: number;
  /** Files found on disk during the walk. */
  scanned: number;
  /** Files on disk with no row and no match — indexed as new. */
  added: number;
  /** Missing rows recognised in a file found elsewhere, and repointed at it. */
  moved: number;
  /** Rows whose file turned up again at its original path (drive remounted). */
  revived: number;
  /** Rows whose file was gone — tombstoned, not deleted. */
  missing: number;
  /** Rows whose file changed size or mtime — derived artifacts re-queued. */
  changed: number;
  /** True when the sweep was stopped early by the index abort epoch. */
  aborted?: boolean;
};

export const RECONCILE_QUEUE = process.env.RECONCILE_QUEUE ?? "reconcile_queue";

/** Deterministic per-(user, root) job id — also the ownership check on read. */
export function reconcileJobId (userId: string, rootPath: string): string {
  return `reconcile-${userId}-${Buffer.from(rootPath).toString("base64url")}`;
}

/** Job-id prefix owned by a user, for finding their active / last sweep. */
export function reconcileJobPrefix (userId: string): string {
  return `reconcile-${userId}-`;
}

export async function enqueueReconcile (
  queue: Queue<ReconcileJobData>,
  job: ReconcileJobData,
  opts: { priority?: number } = {},
): Promise<string> {
  // One in-flight sweep per (user, root): the jobId dedupes repeated submits.
  const jobId = reconcileJobId(job.userId, job.rootPath);

  // BullMQ keeps a finished job's key for the whole retention window, and an
  // `add` under that id does nothing meanwhile. The summary is kept for weeks,
  // so a finished job has to be removed before the next sweep is queued.
  const existing = await queue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state === "completed" || state === "failed") {
      await existing.remove().catch(() => {});
    }
  }

  await queue.add("reconcile", job, {
    jobId,
    attempts: 1, // a partial sweep is resumable by re-running; don't auto-retry a long walk
    ...(opts.priority !== undefined ? { priority: opts.priority } : {}),
    // The finished job is the stored "last run" summary, so it has to outlive
    // the session that produced it. The count caps how many keys that leaves.
    removeOnComplete: { age: 30 * 24 * 3600, count: 20 },
    removeOnFail: { age: 7 * 24 * 3600, count: 20 },
  });
  return jobId;
}
