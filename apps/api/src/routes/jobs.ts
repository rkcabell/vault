import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireAuth } from "../utils/authGuard.js";
import { CLEAR_FAILED_JOBS } from "../lib/http/rateLimits.js";
import {
  isDerivativesPaused,
  pauseDerivatives,
  resumeDerivatives,
} from "../lib/media/derivativePause.js";

/**
 * Reports queue depths, and offers three different stops: cancelling a scan,
 * cancelling only a reconcile sweep, and stopping all processing, which also
 * pauses the derivative feeder.
 *
 * BullMQ queues are global rather than per-user, so in a multi-user install
 * these actions reach everyone's jobs. There is no admin role to gate them on,
 * and the confirm dialog says so instead.
 */

/** The states that make up a "depth" — what is outstanding, plus failures. */
const COUNT_STATES = ["waiting", "active", "delayed", "prioritized", "failed"] as const;

/** Page size for the clean loop; a full page means there may be more. */
const CLEAN_PAGE = 1000;

const clearFailedBodySchema = z.object({ queue: z.string().min(1).optional() });

export const jobsRoutes: FastifyPluginAsync = async app => {
  const readDepths = async () => {
    const entries = await Promise.all(
      Object.entries(app.jobQueues).map(async ([name, queue]) => {
        try {
          const counts = await queue.getJobCounts(...COUNT_STATES);
          const waiting = (counts.waiting ?? 0) + (counts.prioritized ?? 0);
          return [name, {
            waiting,
            active: counts.active ?? 0,
            delayed: counts.delayed ?? 0,
            failed: counts.failed ?? 0,
            pending: waiting + (counts.active ?? 0) + (counts.delayed ?? 0),
          }] as const;
        } catch {
          // One unreachable queue must not blank the whole panel; null renders
          // as "—" rather than as a confident zero.
          return [name, null] as const;
        }
      }),
    );
    return Object.fromEntries(entries);
  };

  app.get("/queues", { preHandler: [requireAuth] }, async () => {
    const [queues, derivativesPaused] = await Promise.all([
      readDepths(),
      isDerivativesPaused(app.redis),
    ]);
    // An absent feeder means DERIVATIVE_FEED_ENABLED=false, which the resume
    // button cannot undo. It is reported apart from the runtime pause.
    return { queues, derivativesPaused, feederEnabled: app.derivativeFeeder !== undefined };
  });

  app.post("/cancel-scan", { preHandler: [requireAuth] }, async (req, reply) => {
    const result = await app.mediaServices.jobControlService.abortProcessing();
    req.log.warn({ userId: req.userId, cleared: result.cleared }, "scan cancelled");
    return reply.send(result);
  });

  app.post("/cancel-reconcile", { preHandler: [requireAuth] }, async (req, reply) => {
    const result = await app.mediaServices.jobControlService.abortReconcile();
    req.log.warn({ userId: req.userId, cleared: result.cleared }, "reconcile cancelled");
    return reply.send(result);
  });

  app.post("/stop-all", { preHandler: [requireAuth] }, async (req, reply) => {
    // Pause first: cancelling the scan takes a moment, and a feeder tick in
    // that window would dispatch another 2,000 jobs the user just asked to stop.
    await pauseDerivatives(app.redis);
    const result = await app.mediaServices.jobControlService.abortProcessing();
    req.log.warn({ userId: req.userId, cleared: result.cleared }, "all processing stopped");
    return reply.send({ ...result, derivativesPaused: true });
  });

  // Every per-item queue now enqueues with `removeOnFail: true`, so a non-zero
  // failed count is a leftover that nothing else clears. This reaches BullMQ
  // only: a FAILED thumbState or an ERROR textState on a media row stands.
  app.post(
    "/failed/clear",
    { preHandler: [requireAuth, app.userRateLimit("clear-failed-jobs", CLEAR_FAILED_JOBS)] },
    async (req, reply) => {
      const body = clearFailedBodySchema.safeParse(req.body ?? {});
      if (!body.success) {
        throw app.httpErrors.badRequest(body.error.errors[0]?.message ?? "Invalid request body");
      }

      const name = body.data.queue;
      if (name && !(name in app.jobQueues)) {
        throw app.httpErrors.badRequest(`Unknown queue: ${name}`);
      }
      const targets = name
        ? [[name, app.jobQueues[name]] as const]
        : Object.entries(app.jobQueues);

      const cleared: Record<string, number> = {};
      for (const [queueName, queue] of targets) {
        let total = 0;
        try {
          // One clean() returns at most `limit` ids, so a backlog larger than
          // that needs the loop — a single call looks like it worked.
          for (;;) {
            const removed = await queue.clean(0, CLEAN_PAGE, "failed");
            total += removed.length;
            if (removed.length < CLEAN_PAGE) break;
          }
        } catch (err) {
          req.log.warn({ err, queue: queueName }, "failed-job clear errored for one queue");
        }
        cleared[queueName] = total;
      }

      req.log.warn({ userId: req.userId, cleared }, "failed jobs cleared");
      return reply.send({ ok: true, cleared });
    },
  );

  app.post("/resume", { preHandler: [requireAuth] }, async (req, reply) => {
    await resumeDerivatives(app.redis);
    // Without the kick the loop would sit out its current idle interval first,
    // which reads as a resume button that did nothing.
    app.derivativeFeeder?.kick();
    req.log.info({ userId: req.userId }, "processing resumed");
    return reply.send({ ok: true, derivativesPaused: false });
  });
};
