import path from "node:path";
import fs from "node:fs";
import type { FastifyPluginAsync } from "fastify";
import { Queue } from "bullmq";
import { z, ZodError } from "zod";
import { requireAuth } from "../utils/authGuard.js";
import { buildRedisConnection } from "../lib/config/redis.js";

function writeEnvKey(envPath: string, key: string, value: string): void {
  const content = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf-8") : "";
  const regex = new RegExp(`^${key}=.*$`, "m");
  const updated = regex.test(content)
    ? content.replace(regex, `${key}=${value}`)
    : `${content.trimEnd()}\n${key}=${value}\n`;
  fs.writeFileSync(envPath, updated, "utf-8");
}

export const serverRoutes: FastifyPluginAsync = async (app) => {
  app.get("/status", { preHandler: [requireAuth] }, async () => {
    return {
      env:          app.config.NODE_ENV,
      apiPort:      app.config.PORT,
      corsOrigin:   app.config.CORS_ORIGIN,
      uptimeSeconds: process.uptime(),
    };
  });

  app.get("/workers", { preHandler: [requireAuth] }, async () => {
    const OCR_QUEUE   = process.env.OCR_QUEUE   ?? "ocr_queue";
    const THUMB_QUEUE = process.env.THUMB_QUEUE ?? "thumb_queue";
    const connection  = buildRedisConnection(app.config.REDIS_URL);

    const ocrQueue   = new Queue(OCR_QUEUE,   { connection });
    const thumbQueue = new Queue(THUMB_QUEUE, { connection });

    try {
      const [ocrWorkers, thumbWorkers] = await Promise.all([
        ocrQueue.getWorkers(),
        thumbQueue.getWorkers(),
      ]);
      return {
        ocr:   { active: ocrWorkers.length   > 0, count: ocrWorkers.length },
        thumb: { active: thumbWorkers.length > 0, count: thumbWorkers.length },
      };
    } finally {
      await Promise.allSettled([ocrQueue.close(), thumbQueue.close()]);
    }
  });

  app.post("/shutdown", { preHandler: [requireAuth] }, async (_req, reply) => {
    void reply.code(202).send({ ok: true });
    // Exit with code 0 so Docker's "on-failure" restart policy does NOT restart
    // the container. SIGTERM would exit with 143 (non-zero), which triggers a restart.
    setTimeout(() => process.exit(0), 200);
  });

  app.post("/restart", { preHandler: [requireAuth] }, async (_req, reply) => {
    void reply.code(202).send({ ok: true });
    setTimeout(() => {
      if (process.env.IS_NODEMON) {
        // Touch a watched trigger file — nodemon detects the change, sends SIGTERM,
        // and respawns the child. Works because nodemon always restarts on file-change
        // kills regardless of exit code.
        fs.writeFileSync(path.join(process.cwd(), "src", ".restart.trigger"), String(Date.now()));
      } else {
        process.kill(process.pid, "SIGTERM");
      }
    }, 200);
  });

  app.patch("/config", { preHandler: [requireAuth] }, async (req, reply) => {
    if (app.config.NODE_ENV === "production") {
      throw app.httpErrors.forbidden("Use environment variables in production.");
    }

    let apiPort: number | undefined;
    try {
      ({ apiPort } = z.object({
        apiPort: z.coerce.number().int().min(1024).max(65535).optional(),
      }).parse(req.body));
    } catch (e) {
      if (e instanceof ZodError) {
        throw app.httpErrors.badRequest(e.errors[0]?.message ?? "Invalid request body");
      }
      throw e;
    }

    if (apiPort !== undefined) {
      const envPath =
        process.env.DOTENV_CONFIG_PATH ?? path.join(process.cwd(), ".env");
      writeEnvKey(envPath, "PORT", String(apiPort));
    }

    void reply.code(202).send({ ok: true });
    setTimeout(() => {
      if (process.env.IS_NODEMON) {
        fs.writeFileSync(path.join(process.cwd(), "src", ".restart.trigger"), String(Date.now()));
      } else {
        process.kill(process.pid, "SIGTERM");
      }
    }, 200);
  });
};
