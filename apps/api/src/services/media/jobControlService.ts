import type { Queue } from "bullmq";
import type { IndexJobData } from "../../queues/enqueueIndex.js";
import type { ReconcileJobData } from "../../queues/enqueueReconcile.js";
import { signalIndexAbort, type AbortRedis } from "../../lib/media/indexAbort.js";
import { signalReconcileAbort } from "../../lib/media/reconcileAbort.js";

/**
 * Cancels running scans and sweeps. Cancelling means two things: bumping an
 * abort epoch so a walk already running stops adding jobs, and draining the
 * jobs still queued behind it.
 */

type JobControlDeps = {
  // The plugin always provides all three. Optional so a test can wire only one.
  indexQueue?: Queue<IndexJobData>;
  /** Drained alongside `indexQueue` on cancel. A sweep reads the abort epoch
   *  when it starts, so one still queued would run with the new value. */
  reconcileQueue?: Queue<ReconcileJobData>;
  // Bumps the index-abort and reconcile-abort epochs, which stop a running walk or sweep.
  redis?: Pick<AbortRedis, "incr">;
};

/**
 * Pauses each queue, removes its waiting and delayed jobs, clears its terminal
 * jobs, then resumes it. Jobs already active finish on their own. `obliterate`
 * cannot be used here: it deletes jobs mid-process, and the worker then throws
 * "Missing key for job … moveToDelayed".
 */
const drainQueues = async (targets: [string, Queue<unknown> | undefined][]) => {
  const cleared: string[] = [];
  await Promise.all(
    targets.map(async ([name, queue]) => {
      if (!queue) return;
      try {
        await queue.pause();
        await queue.drain(true); // true also removes delayed jobs
        await queue.clean(0, 0, "failed");
        await queue.clean(0, 0, "completed");
        cleared.push(name);
      } catch {
        // A worker tick can race the drain.
      } finally {
        // A queue left paused would stall all later indexing.
        try {
          await queue.resume();
        } catch {
          /* ignore */
        }
      }
    }),
  );
  // Sorted for a stable response; the drains run concurrently.
  return { ok: true, cleared: cleared.sort() };
};

export function createJobControlService (deps: JobControlDeps) {
  /**
   * Stops the running directory walk and clears the scans and sweeps behind it.
   * Backs POST /api/jobs/cancel-scan.
   */
  const abortProcessing = async () => {
    // The abort epochs stop a running walk or sweep from adding more jobs.
    // Draining first would lower the count only for a moment, because the
    // running walk refills it.
    if (deps.redis) {
      try {
        await signalIndexAbort(deps.redis);
      } catch {
        // The queue drain below still clears the existing backlog.
      }
      try {
        await signalReconcileAbort(deps.redis);
      } catch {
        // The queue drain below still clears the existing backlog.
      }
    }

    // Thumbnail, text and hash jobs already enqueued are left to finish.
    // Stopping those is a separate action in lib/media/derivativePause.
    return drainQueues([
      ["index", deps.indexQueue as Queue<unknown> | undefined],
      ["reconcile", deps.reconcileQueue as Queue<unknown> | undefined],
    ]);
  };

  /**
   * Stops the reconcile sweep and leaves any index scan running.
   * Backs POST /api/jobs/cancel-reconcile.
   */
  const abortReconcile = async () => {
    if (deps.redis) {
      try {
        await signalReconcileAbort(deps.redis);
      } catch {
        // The queue drain below still clears the existing backlog.
      }
    }
    return drainQueues([["reconcile", deps.reconcileQueue as Queue<unknown> | undefined]]);
  };

  return { abortProcessing, abortReconcile };
}
