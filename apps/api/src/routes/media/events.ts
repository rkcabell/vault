/**
 * Streams job progress to an open page, so a thumbnail or extracted text
 * appears as soon as a worker finishes it.
 */
import type { FastifyPluginAsync } from "fastify";
import { requireAuth } from "../../utils/authGuard.js";
import type { JobUpdateEvent } from "../../plugins/queueEvents.js";

/**
 * Keeps one long-lived connection per open page.
 *
 * Separate from the other media routes because it holds its socket open for as
 * long as the page is open, rather than answering and finishing.
 */
export const mediaEventsRoutes: FastifyPluginAsync = async app => {
  // The connection stays open and events are written to it as they arrive.
  app.get("/events", { preHandler: [requireAuth] }, (req, reply) => {
    const userId = req.userId!;

    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.flushHeaders();

    // Fastify must not try to send a response of its own after this point.
    reply.hijack();

    const send = (data: object) => {
      if (!reply.raw.writableEnded) reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // A silent connection is closed by some proxies, so send something
    // harmless at an interval to keep it open.
    const ping = setInterval(() => {
      if (!reply.raw.writableEnded) reply.raw.write(": ping\n\n");
    }, 25_000);

    const listener = (event: JobUpdateEvent) => {
      if (event.userId === userId) {
        send({ mediaId: event.mediaId, field: event.field, value: event.value });
      }
    };

    app.jobEvents.on("update", listener);

    req.raw.once("close", () => {
      clearInterval(ping);
      app.jobEvents.off("update", listener);
      if (!reply.raw.writableEnded) reply.raw.end();
    });
  });
};
