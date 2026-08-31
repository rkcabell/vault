import fp from "fastify-plugin";
import { randomUUID } from "node:crypto";
import type { FastifyRequest, FastifyReply } from "fastify";

/**
 * Counts a caller's recent requests in Redis and refuses the ones over a
 * bucket's limit. A Redis failure lets the request through rather than locking
 * the owner out of their own server.
 */

type Bucket = { limit?: number; windowMs?: number };

/** A literal key, or one computed per request (a user id is only known then). */
type RateLimitOpts = Bucket & { key: string | ((req: FastifyRequest) => string) };

type Guard = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

declare module "fastify" {
  interface FastifyInstance {
    rateLimit: (opts: RateLimitOpts) => Guard;
    userRateLimit: (name: string, bucket?: Bucket) => Guard;
  }
}

export default fp(
  async (app) => {
    const rateLimit = ({ key, limit = 60, windowMs = 60_000 }: RateLimitOpts): Guard => {
      return async (req, reply) => {
        const now = Date.now();
        const start = now - windowMs;
        const k = `ratelimit:${typeof key === "function" ? key(req) : key}`;

        const pipeline = app.redis.multi();
        pipeline.zremrangebyscore(k, 0, start);
        // Member must be unique per request: ZADD on an existing member updates
        // its score, so a bare timestamp makes ZCARD count milliseconds.
        pipeline.zadd(k, now, `${now}-${randomUUID()}`);
        pipeline.zcard(k);
        pipeline.pexpire(k, windowMs);

        const execRes = await pipeline.exec(); // [ [err, res], [err, res], ... ] | null
        if (!Array.isArray(execRes)) {
          // Fails open: Redis being down must not lock the owner out.
          app.log.warn("rateLimit pipeline returned null");
          return;
        }

        // The third command is the ZCARD, and its result is [err, count].
        const zcardTuple = execRes[2]; // undefined if the pipeline above changes
        const zcardErr = zcardTuple?.[0] as Error | null | undefined;
        const countRaw = zcardTuple?.[1];
        if (zcardErr) {
          app.log.warn({ err: zcardErr }, "rateLimit zcard failed"); // fail open, see above
          return;
        }

        const count = Number(countRaw ?? 0);

        // ZADD already counted this request, so `>` admits exactly `limit`.
        if (count > limit) {
          const ttlMs = await app.redis.pttl(k); // -2: no key, -1: no expire
          const effectiveTtl = ttlMs > 0 ? ttlMs : windowMs;
          const retry = Math.max(1, Math.ceil(effectiveTtl / 1000));
          reply.header("Retry-After", String(retry));
          return reply.status(429).send({ error: "rate_limited", limit, windowMs });
        }
      };
    };

    /**
     * Returns a guard that counts against a per-account bucket. Place it after
     * `requireAuth`, so `req.userId` is set: the IP fallback covers only a
     * caller that reorders them, and behind the proxy that IP is the same for
     * every user unless TRUST_PROXY is on.
     */
    const userRateLimit = (name: string, bucket: Bucket = {}): Guard =>
      rateLimit({ ...bucket, key: req => `${name}:${req.userId ? `u:${req.userId}` : `ip:${req.ip}`}` });

    app.decorate("rateLimit", rateLimit);
    app.decorate("userRateLimit", userRateLimit);
  },
  { name: "rateLimit" },
);
