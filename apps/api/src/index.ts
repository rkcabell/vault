//File: apps/api/src/index.ts
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import { configPlugin } from "./plugins/config.js";
import { healthRoutes } from "./routes/health.js";
import prismaPlugin from "./plugins/prisma.js";
import jwtPlugin from "./plugins/jwt.js";
import { authRoutes } from "./routes/auth.js";
import { profileRoutes } from "./routes/profile.js";
import s3Plugin from "./plugins/s3.js";
import mediaServicesPlugin from "./plugins/mediaServices.js";
import { mediaRoutes } from "./routes/media.js";
import { tagsRoutes } from "./routes/tags.js";
import { remindersRoutes } from "./routes/reminders.js";
import { bundlesRoutes } from "./routes/bundles.js";
import queueEventsPlugin from "./plugins/queueEvents.js";
import redisPlugin from "./plugins/redis.js";
import rateLimitPlugin from "./plugins/rateLimit.js";
import dotenv from "dotenv";
import path from "node:path";
import cookie from "@fastify/cookie";
import { createLogger, LOG_FORMATTERS, buildTransportTargets } from "./lib/logger.js";
import { initLogFile } from "./lib/logFileManager.js";

dotenv.config({
  path: process.env.DOTENV_CONFIG_PATH ?? path.join(process.cwd(), ".env"),
});

initLogFile();

async function main () {
  const level = process.env.LOG_LEVEL ?? "info";

  const app = Fastify({
    disableRequestLogging: true,
    logger: {
      level,
      base: { name: "api" },
      formatters: LOG_FORMATTERS,
      transport: { targets: buildTransportTargets(level) },
    },
  });

  registerShutdown(app);

  app.addHook("onResponse", (req, reply, done) => {
    if (reply.statusCode >= 500) {
      app.log.error({ method: req.method, url: req.url, status: reply.statusCode }, "server error");
    } else if (reply.statusCode >= 400) {
      app.log.warn({ method: req.method, url: req.url, status: reply.statusCode }, "client error");
    }
    done();
  });

  //Fastify instance
  await app.register(configPlugin); // loads & validates env into app.config
  await app.register(cookie, { secret: app.config.JWT_SECRET }); // registers cookie plugin
  await app.register(cors, { origin: app.config.CORS_ORIGIN, credentials: true });
  await app.register(sensible); // adds handy utilities
  await app.register(healthRoutes, { prefix: "/health" }); // /healthz, /readyz
  await app.register(prismaPlugin); // registers a PrismaClient (DB)
  await app.register(jwtPlugin); // registers jwt plugin
  await app.register(authRoutes, { prefix: "/api/auth" }); // auth routes plugin
  await app.register(profileRoutes, { prefix: "/api/profile" });
  await app.register(s3Plugin); // aws bucket storage
  await app.register(mediaServicesPlugin); // media services + queues wiring
  await app.register(queueEventsPlugin); // shared QueueEvents + jobEvents emitter for SSE
  await app.register(mediaRoutes, { prefix: "/api/media" });
  await app.register(tagsRoutes, { prefix: "/api/tags" });
  await app.register(remindersRoutes, { prefix: "/api/reminders" });
  await app.register(bundlesRoutes, { prefix: "/api/bundles" });
  await app.register(redisPlugin); // Redis for queue/rate-limit groundwork
  await app.register(rateLimitPlugin); // Redis rate limit

  const port = app.config.PORT;
  const host = app.config.HOST;
  await app.listen({ port, host });
  app.log.info(`API up at http://${host}:${port}`);
}

main().catch(err => {
  const logger = createLogger("api");
  logger.error({ err }, "fatal startup error");
  process.exit(1);
});

function registerShutdown (app: FastifyInstance) {
  let isShuttingDown = false;

  const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    try {
      app.log.info({ signal }, "Shutting down");
      await app.close(); // releases the port
    } catch (err) {
      app.log.error(err, "Shutdown error");
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}
