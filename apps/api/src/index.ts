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
import storagePlugin from "./plugins/storage.js";
import mediaServicesPlugin from "./plugins/mediaServices.js";
import { mediaRoutes } from "./routes/media.js";
import { tagsRoutes } from "./routes/tags.js";
import { remindersRoutes } from "./routes/reminders.js";
import { bundlesRoutes } from "./routes/bundles.js";
import { preferencesRoutes } from "./routes/preferences.js";
import { initRoutes } from "./routes/init.js";
import { serverRoutes } from "./routes/server.js";
import { storageRoutes } from "./routes/storage.js";
import preferencesPlugin from "./plugins/preferences.js";
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

if (process.env.NODE_ENV !== "production") initLogFile();

async function main () {
  const level = process.env.LOG_LEVEL ?? "info";
  const transportTargets = buildTransportTargets(level);

  const app = Fastify({
    disableRequestLogging: true,
    logger: {
      level,
      base: { name: "api" },
      formatters: LOG_FORMATTERS,
      ...(transportTargets.length > 0 ? { transport: { targets: transportTargets } } : {}),
    },
  });

  registerShutdown(app);

  // Surface the real error message instead of the generic "Internal Server Error".
  app.setErrorHandler((error, req, reply) => {
    if (error.statusCode) {
      // HTTP error created by @fastify/sensible
      void reply.status(error.statusCode).send(error);
    } else {
      req.log.error({ err: error }, "unhandled error");
      void reply.status(500).send({
        statusCode: 500,
        error: "Internal Server Error",
        message: error.message || "Internal Server Error",
      });
    }
  });

  app.addHook("onResponse", (req, reply, done) => {
    if (reply.statusCode >= 500) {
      app.log.error({ method: req.method, url: req.url, status: reply.statusCode }, "server error");
    } else if (reply.statusCode >= 400) {
      app.log.warn({ method: req.method, url: req.url, status: reply.statusCode }, "client error");
    }
    done();
  });

  await app.register(configPlugin); // loads & validates env into app.config
  await app.register(cookie, { secret: app.config.JWT_SECRET });
  await app.register(cors, { origin: app.config.CORS_ORIGIN, credentials: true });
  await app.register(sensible);
  await app.register(healthRoutes, { prefix: "/health" });
  await app.register(prismaPlugin);
  await app.register(jwtPlugin);
  await app.register(authRoutes, { prefix: "/api/auth" });
  await app.register(profileRoutes, { prefix: "/api/profile" });
  await app.register(s3Plugin); // S3/MinIO client (s3 mode only)
  await app.register(storagePlugin); // app.storage adapter (s3 or filesystem)
  await app.register(preferencesPlugin);
  // register redis before mediaServices
  await app.register(redisPlugin);
  await app.register(mediaServicesPlugin);
  await app.register(queueEventsPlugin); // shared QueueEvents → jobEvents emitter for SSE
  await app.register(mediaRoutes, { prefix: "/api/media" });
  await app.register(tagsRoutes, { prefix: "/api/tags" });
  await app.register(remindersRoutes, { prefix: "/api/reminders" });
  await app.register(bundlesRoutes, { prefix: "/api/bundles" });
  await app.register(preferencesRoutes, { prefix: "/api/preferences" });
  await app.register(initRoutes, { prefix: "/api/init" });
  await app.register(serverRoutes, { prefix: "/api/server" });
  await app.register(storageRoutes, { prefix: "/api/storage" });
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
