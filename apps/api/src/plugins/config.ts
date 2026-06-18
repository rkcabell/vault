import fp from "fastify-plugin";
import { z } from "zod";

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    HOST: z.string().default("127.0.0.1"),
    PORT: z.coerce.number().int().positive().default(8000),
    CORS_ORIGIN: z.string().default("http://localhost:3000"),

    // Stubs for later steps (add real values when wiring DB/MinIO/Redis)
    POSTGRES_URL: z.string().url().optional(),
    JWT_SECRET: z.string().min(32),
    JWT_REFRESH_SECRET: z.string().min(32),

    // Storage backend selection. "fs" (default) stores blobs on a filesystem
    // path (mountable from a NAS share); "s3" uses the S3_* settings below.
    STORAGE_DRIVER: z.enum(["s3", "fs"]).default("fs"),
    // Defaults so filesystem mode works zero-config; override for a real path
    // (e.g. a mounted NAS share). Empty string still fails the fs superRefine.
    STORAGE_FS_PATH: z.string().default("/data/vault"),

    // S3_* are required only when STORAGE_DRIVER=s3 (enforced in superRefine).
    S3_ENDPOINT: z.string().url().optional(),
    S3_PUBLIC_ENDPOINT: z.string().url().optional(),
    S3_REGION: z.string().default("us-east-1"),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),
    // Logical namespace for object keys. Used as the S3 bucket name; ignored by
    // the filesystem adapter, so it carries a default that fs deployments inherit.
    S3_BUCKET: z.string().default("vault-media"),
    REDIS_URL: z.string().url(),
  })
  .superRefine((val, ctx) => {
    if (val.STORAGE_DRIVER === "s3") {
      const required = [
        "S3_ENDPOINT",
        "S3_PUBLIC_ENDPOINT",
        "S3_ACCESS_KEY_ID",
        "S3_SECRET_ACCESS_KEY",
      ] as const;
      for (const key of required) {
        if (!val[key]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `${key} is required when STORAGE_DRIVER=s3`,
          });
        }
      }
    } else if (!val.STORAGE_FS_PATH) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["STORAGE_FS_PATH"],
        message: "STORAGE_FS_PATH is required when STORAGE_DRIVER=fs",
      });
    }
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
