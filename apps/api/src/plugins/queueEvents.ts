/**
 * Carries progress messages from the worker processes to the browser.
 *
 * Workers publish to a Redis channel named for the user. This plugin listens
 * on every such channel and re-emits what arrives, which the media events
 * route then streams to that user's open pages.
 */
import fp from "fastify-plugin";
import IORedis from "ioredis";
import EventEmitter from "node:events";
import { isMediaEventField, type MediaEvent, type MediaEventField } from "@vault/types";

/** One worker message together with the user it belongs to. */
export type JobUpdateEvent = MediaEvent & { userId: string };
export type { MediaEventField };

declare module "fastify" {
  interface FastifyInstance {
    jobEvents: EventEmitter;
  }
}

// Values a per-item message may carry. The two list-membership fields carry a
// count instead, as a string of digits.
const STATE_VALUES = new Set(["READY", "ERROR", "FAILED", "UNSUPPORTED", "updated"]);

export default fp(
  async app => {
    const emitter = new EventEmitter();
    emitter.setMaxListeners(0); // allow many concurrent SSE connections

    // Dedicated subscriber connection — a subscribed IORedis client cannot run other commands
    const subscriber = new IORedis(app.config.REDIS_URL);
    subscriber.on("error", err => app.log.warn({ err }, "jobEvents subscriber error"));

    await subscriber.psubscribe("media-events:*");

    subscriber.on("pmessage", (_pattern: string, channel: string, message: string) => {
      // A message is only relayed to the user whose channel it arrived on.
      const userId = channel.slice("media-events:".length);
      if (!userId) return;
      try {
        const payload = JSON.parse(message) as { mediaId?: string; field?: string; value?: string };
        if (!payload.mediaId || !payload.field || !payload.value) return;
        const { field, value } = payload;
        if (!isMediaEventField(field)) return;
        if (field === "mediaDeleted" || field === "mediaCreated") {
          if (!/^\d+$/.test(value)) return;
        } else if (!STATE_VALUES.has(value)) {
          return;
        }
        emitter.emit("update", {
          mediaId: payload.mediaId,
          userId,
          field,
          value,
        } satisfies JobUpdateEvent);
      } catch {
        // ignore malformed messages
      }
    });

    app.decorate("jobEvents", emitter);

    app.addHook("onClose", async () => {
      await subscriber.quit();
    });
  },
  { name: "queueEvents" },
);
