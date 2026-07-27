import type { Queue } from "bullmq";

/**
 * A request to reconcile one indexing root: a bidirectional diff between what
 * the library believes is on disk and what is actually there.
 *
 * The live watcher only sees events while Vault is running, and a plain index
 * scan deliberately skips paths that already have a row. So anything deleted,
 * moved, or edited while the worker was down is invisible to both — the library
 * drifts permanently out of sync with the disk. This job is the only thing that
 * closes that gap.
 */
export type ReconcileJobData = {
  userId: string;
  /** Absolute root to reconcile. Re-validated against allowedRoots in the worker. */
  rootPath: string;
  /** Snapshotted from user preferences at enqueue time; worker validates rootPath against these. */
  allowedRoots: string[];
  /** Skip dotfiles — mirrors the ignoreHiddenFiles preference. */
  ignoreHidden: boolean;
  /** Extensions (lowercase, no dot) to skip — snapshotted from preferences at enqueue time. */
  blacklistExtensions?: string[];
  /** Absolute folders (and their subtrees) to skip — snapshotted from preferences at enqueue time. */
  excludeFolders?: string[];
  /** Skip build/dependency dirs + non-content file types — snapshotted from preferences at enqueue time. */
  skipNonContent?: boolean;
};

/**
 * Live progress attached to the BullMQ job, and its final return value — which
 * doubles as the "last run" summary the indexing settings card shows, so the
 * counters here are user-facing wording, not internal bookkeeping.
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

  // BullMQ keeps the job key for the full retention window even after it
  // finishes, and within that window `add` with the same jobId is a silent
  // no-op. Since the summary is retained for weeks (below), a terminal job must
  // be removed explicitly or the button would stop working after the first run.
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
    // Long retention on purpose: the completed job *is* the stored "last run"
    // summary the settings card reads, so it has to outlive the session that
    // produced it. Capped by count so the key set stays bounded.
    removeOnComplete: { age: 30 * 24 * 3600, count: 20 },
    removeOnFail: { age: 7 * 24 * 3600, count: 20 },
  });
  return jobId;
}
