import fp from "fastify-plugin";
import type { FastifyRequest, FastifyReply } from "fastify";

type RLFn = (opts: {
  key: string;
  limit?: number;
  windowMs?: number;
}) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

declare module "fastify" {
  interface FastifyInstance {
    rateLimit: RLFn;
  }
}

export default fp(
  async (app) => {
    const rateLimit: RLFn = ({ key, limit = 60, windowMs = 60_000 }) => {
      return async (_req, reply) => {
        const now = Date.now();
        const start = now - windowMs;
        const k = `ratelimit:${key}`;

        // Build pipeline
        const pipeline = app.redis.multi();
        pipeline.zremrangebyscore(k, 0, start);
        pipeline.zadd(k, now, String(now)); // member = timestamp string
        pipeline.zcard(k);
        pipeline.pexpire(k, windowMs); // ensure key expires if idle

        // Exec and handle types safely
        const execRes = await pipeline.exec(); // [ [err, res], [err, res], ... ] | null
        if (!Array.isArray(execRes)) {
          // Fail-open on unexpected null; alternatively reply 429 or log.
          app.log.warn("rateLimit pipeline returned null");
          return;
        }

        // Third command is ZCARD → tuple [err, count]
        const zcardTuple = execRes[2]; // may be undefined if pipeline changes
        const zcardErr = zcardTuple?.[0] as Error | null | undefined;
        const countRaw = zcardTuple?.[1];
        if (zcardErr) {
          app.log.warn({ err: zcardErr }, "rateLimit zcard failed");
          return;
        }

        const count = Number(countRaw ?? 0);

        if (count > limit) {
          const ttlMs = await app.redis.pttl(k); // -2: no key, -1: no expire
          const effectiveTtl = ttlMs > 0 ? ttlMs : windowMs;
          const retry = Math.max(1, Math.ceil(effectiveTtl / 1000));
          reply.header("Retry-After", String(retry));
          return reply.status(429).send({ error: "rate_limited", limit, windowMs });
        }
      };
    };

    app.decorate("rateLimit", rateLimit);
  },
  { name: "rateLimit" },
);
