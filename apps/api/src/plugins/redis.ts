/**
 * Puts a Redis client on the Fastify instance for caching, rate limiting and
 * the derivative pause switch.
 *
 * The queueEvents plugin opens a second connection of its own, because a
 * client that is subscribed to a channel cannot run ordinary commands.
 */
import fp from "fastify-plugin";
import IORedis from "ioredis";

declare module "fastify" {
  interface FastifyInstance {
    redis: IORedis;
  }
}

export default fp(
  async (app) => {
    const url = app.config.REDIS_URL;
    const client = new IORedis(url);

    client.on("error", (e) => app.log.error({ err: e }, "Redis error"));
    app.addHook("onClose", async () => {
      try {
        await client.quit();
      } catch (err) {
        app.log.warn({ err }, "Redis quit failed");
      }
    });

    app.decorate("redis", client);
  },
  { name: "redis" },
);
