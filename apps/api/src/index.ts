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
import storagePlugin from "./plugins/storage.js";
import mediaServicesPlugin from "./plugins/mediaServices.js";
import derivativeFeederPlugin from "./plugins/derivativeFeeder.js";
import derivativeProgressPlugin from "./plugins/derivativeProgress.js";
import { mediaLibraryRoutes } from "./routes/media/library.js";
import { mediaDuplicatesRoutes } from "./routes/media/duplicates.js";
import { mediaEventsRoutes } from "./routes/media/events.js";
import { mediaItemsRoutes } from "./routes/media/items.js";
import { mediaContentRoutes } from "./routes/media/content.js";
import { mediaDerivativesRoutes } from "./routes/media/derivatives.js";
import { mediaIndexingRoutes } from "./routes/media/indexing.js";
import { mediaDeleteJobRoutes } from "./routes/media/deleteJobs.js";
import { mediaArchiveRoutes } from "./routes/media/archives.js";
import { tagsRoutes } from "./routes/tags.js";
import { tagRulesRoutes } from "./routes/tagRules.js";
import { remindersRoutes } from "./routes/reminders.js";
import { bundlesRoutes } from "./routes/bundles.js";
import { preferencesRoutes } from "./routes/preferences.js";
import { initRoutes } from "./routes/init.js";
import { serverRoutes } from "./routes/server.js";
import { jobsRoutes } from "./routes/jobs.js";
import { sidecarRoutes } from "./routes/sidecars.js";
import { storageRoutes } from "./routes/storage.js";
import { ingestRoutes } from "./routes/ingest.js";
import sidecarPlugin from "./plugins/sidecar.js";
import preferencesPlugin from "./plugins/preferences.js";
import queueEventsPlugin from "./plugins/queueEvents.js";
import redisPlugin from "./plugins/redis.js";
import rateLimitPlugin from "./plugins/rateLimit.js";
import csrfPlugin from "./plugins/csrf.js";
import dotenv from "dotenv";
import path from "node:path";
import cookie from "@fastify/cookie";
import { createLogger, LOG_FORMATTERS, buildTransportTargets } from "./lib/logger.js";
import { initLogFile } from "./lib/logFileManager.js";

/**
 * Builds the Fastify application and starts it. The registration order below is
 * load-bearing: config, redis, prisma, storage and preferences all have to be in
 * place before any route that reads them.
 */

dotenv.config({
  path: process.env.DOTENV_CONFIG_PATH ?? path.join(process.cwd(), ".env"),
});

if (process.env.NODE_ENV !== "production") initLogFile();

async function main () {
  const level = process.env.LOG_LEVEL ?? "info";
  const transportTargets = buildTransportTargets(level);

  const app = Fastify({
    disableRequestLogging: true,
    // Read from the environment because app.config does not exist yet.
    // See TRUST_PROXY in plugins/config.ts for when to turn it on.
    trustProxy: process.env.TRUST_PROXY === "true",
    logger: {
      level,
      base: { name: "api" },
      formatters: LOG_FORMATTERS,
      ...(transportTargets.length > 0 ? { transport: { targets: transportTargets } } : {}),
    },
  });

  registerShutdown(app);

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
  // Both come before any route: csrf hooks every request, and the rate
  // limiter needs redis.
  await app.register(csrfPlugin);
  await app.register(redisPlugin);
  await app.register(rateLimitPlugin);
  await app.register(healthRoutes, { prefix: "/health" });
  await app.register(prismaPlugin);
  await app.register(jwtPlugin);
  await app.register(authRoutes, { prefix: "/api/auth" });
  await app.register(profileRoutes, { prefix: "/api/profile" });
  await app.register(storagePlugin);
  await app.register(preferencesPlugin);
  await app.register(mediaServicesPlugin);
  await app.register(derivativeFeederPlugin);
  await app.register(derivativeProgressPlugin);
  await app.register(sidecarPlugin);
  await app.register(queueEventsPlugin);
  await app.register(mediaLibraryRoutes, { prefix: "/api/media" });
  await app.register(mediaDuplicatesRoutes, { prefix: "/api/media" });
  await app.register(mediaEventsRoutes, { prefix: "/api/media" });
  await app.register(mediaItemsRoutes, { prefix: "/api/media" });
  await app.register(mediaContentRoutes, { prefix: "/api/media" });
  await app.register(mediaDerivativesRoutes, { prefix: "/api/media" });
  await app.register(mediaIndexingRoutes, { prefix: "/api/media" });
  await app.register(mediaDeleteJobRoutes, { prefix: "/api/media" });
  await app.register(mediaArchiveRoutes, { prefix: "/api/media" });
  await app.register(tagsRoutes, { prefix: "/api/tags" });
  await app.register(tagRulesRoutes, { prefix: "/api/tag-rules" });
  await app.register(remindersRoutes, { prefix: "/api/reminders" });
  await app.register(bundlesRoutes, { prefix: "/api/bundles" });
  await app.register(preferencesRoutes, { prefix: "/api/preferences" });
  await app.register(initRoutes, { prefix: "/api/init" });
  await app.register(serverRoutes, { prefix: "/api/server" });
  await app.register(jobsRoutes, { prefix: "/api/jobs" });
  await app.register(sidecarRoutes, { prefix: "/api/sidecars" });
  await app.register(storageRoutes, { prefix: "/api/storage" });
  await app.register(ingestRoutes, { prefix: "/api/ingest" });

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
