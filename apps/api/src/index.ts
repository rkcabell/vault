import Fastify from "fastify";
import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import { configPlugin } from "./plugins/config.js";
import { healthRoutes } from "./routes/health.js";
import prismaPlugin from "./plugins/prisma.js";
import jwtPlugin from "./plugins/jwt.js";
import { authRoutes } from "./routes/auth.js";
import { profileRoutes } from "./routes/profile.js";
import s3Plugin from "./plugins/s3.js";
import { mediaRoutes } from "./routes/media.js";
import redisPlugin from "./plugins/redis.js";
import rateLimitPlugin from "./plugins/rateLimit.js";
import dotenv from "dotenv";
import path from "node:path";
import cookie from "@fastify/cookie";

dotenv.config({
  path: process.env.DOTENV_CONFIG_PATH ?? path.join(process.cwd(), ".env"),
});

async function main () {
  const app = Fastify({
    logger:
      process.env.NODE_ENV === "production"
        ? { level: "info" }
        : { level: "info", transport: { target: "pino-pretty", options: { colorize: true } } },
  });

  registerShutdown(app);

  //Fastify instance
  await app.register(configPlugin); // loads & validates env into app.config
  await app.register(cookie, { secret: app.config.JWT_SECRET,}); // registers cookie plugin
  await app.register(cors, { origin: true }); // dev-friendly; lock down later
  await app.register(sensible); // adds handy utilities
  await app.register(healthRoutes, { prefix: "/health" }); // /healthz, /readyz
  await app.register(prismaPlugin); // registers a PrismaClient (DB)
  await app.register(jwtPlugin); // registers jwt plugin
  await app.register(authRoutes, { prefix: "/api/auth" }); // auth routes plugin
  await app.register(profileRoutes, { prefix: "/api/profile" });
  await app.register(s3Plugin); // aws bucket storage
  await app.register(mediaRoutes, { prefix: "/api/media" });
  await app.register(redisPlugin); // Redis for queue/rate-limit groundwork
  await app.register(rateLimitPlugin); // Redis rate limit

  const port = app.config.PORT;
  const host = app.config.HOST;
  await app.listen({ port, host });
  app.log.info(`API up at http://${host}:${port}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

function registerShutdown(app: any) {
  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;

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
