import fp from "fastify-plugin";
import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().positive().default(8000),
  CORS_ORIGIN: z.string().default("http://localhost:3000"),

  // Stubs for later steps (add real values when wiring DB/MinIO/Redis)
  POSTGRES_URL: z.string().url().optional(),
  JWT_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  S3_ENDPOINT: z.string().url(),
  S3_PUBLIC_ENDPOINT: z.string().url(),
  S3_REGION: z.string().default("us-east-1"),
  S3_ACCESS_KEY_ID: z.string(),
  S3_SECRET_ACCESS_KEY: z.string(),
  S3_BUCKET: z.string(),
  REDIS_URL: z.string().url(),
});

declare module "fastify" {
  interface FastifyInstance {
    config: z.infer<typeof EnvSchema>;
  }
}

export const configPlugin = fp(async (app) => {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    app.log.error(parsed.error.format(), "Invalid environment configuration");
    throw new Error("Invalid environment configuration");
  }
  app.decorate("config", parsed.data);
});
