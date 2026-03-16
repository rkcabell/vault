import fp from "fastify-plugin";
import IORedis from "ioredis";
import EventEmitter from "node:events";

export type JobUpdateEvent = {
  mediaId: string;
  userId: string;
  field: "textState" | "thumbState";
  value: "READY" | "ERROR" | "FAILED";
};

declare module "fastify" {
  interface FastifyInstance {
    jobEvents: EventEmitter;
  }
}

export default fp(
  async app => {
    const emitter = new EventEmitter();
    emitter.setMaxListeners(0); // allow many concurrent SSE connections

    // Dedicated subscriber connection — a subscribed IORedis client cannot run other commands
    const subscriber = new IORedis(app.config.REDIS_URL);
    subscriber.on("error", err => app.log.warn({ err }, "jobEvents subscriber error"));

    await subscriber.psubscribe("media-events:*");

    subscriber.on("pmessage", (_pattern: string, channel: string, message: string) => {
      // channel = "media-events:{userId}"
      const userId = channel.slice("media-events:".length);
      if (!userId) return;
      try {
        const payload = JSON.parse(message) as { mediaId?: string; field?: string; value?: string };
        if (!payload.mediaId || !payload.field || !payload.value) return;
        const field = payload.field;
        const value = payload.value;
        if (field !== "textState" && field !== "thumbState") return;
        if (value !== "READY" && value !== "ERROR" && value !== "FAILED") return;
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
