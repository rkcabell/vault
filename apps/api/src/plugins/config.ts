import fp from "fastify-plugin";
import { z } from "zod";
import { parseAllowedRoots } from "../lib/media/indexRoots.js";

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
    // Token lifetimes (any `jsonwebtoken` expiresIn string, e.g. "15m", "7d").
    // Short access TTL + silent refresh bounds the eviction window after a
    // tokenVersion bump (password reset) to roughly one access lifetime.
    JWT_ACCESS_TTL: z.string().default("15m"),
    JWT_REFRESH_TTL: z.string().default("7d"),

    // Blob storage location: all managed originals + thumbnails live under this
    // filesystem path (point it at a local drive or a mounted NAS share).
    // Defaults so a zero-config boot works.
    STORAGE_FS_PATH: z.string().min(1).default("/data/vault"),
    // Logical key namespace, threaded through service calls but inert on the
    // filesystem backend. Kept to avoid churn; removed with the key-scheme rework.
    STORAGE_BUCKET: z.string().default("vault-media"),
    REDIS_URL: z.string().url(),

    // In-place indexing allow-list: comma-separated absolute directories Vault
    // may walk and read originals from without copying them. Empty/unset = the
    // in-place indexing feature is disabled. See lib/media/indexRoots.ts.
    INDEX_ALLOWED_ROOTS: z.string().optional(),

    // Lock out new account creation once the owner's account exists. Parsed as
    // a string for the same "false"-coercion reason as LOCAL_EXPLORER below,
    // but with the opposite default (off unless explicitly enabled).
    DISABLE_REGISTRATION: z
      .string()
      .optional()
      .transform(v => v === "true"),

    // Whether the server may open a native file manager (Explorer/Finder) on the
    // host. Only valid when the browser and server share a machine (local dev /
    // single-user desktop). Set LOCAL_EXPLORER=false for remote, containerized,
    // or multi-user deployments so the server-side reveal is refused and the
    // button is hidden. Default on (unset = enabled).
    //
    // Parsed as a string, not z.coerce.boolean(): coercion is Boolean(value), so
    // the string "false" would coerce to true and silently leave the feature on.
    // Matches the worker's `!== "false"` env convention.
    LOCAL_EXPLORER: z
      .string()
      .optional()
      .transform(v => v !== "false"),
  })
  // Expose the parsed allow-list alongside the raw env var so callers read a
  // normalized string[] (`config.indexAllowedRoots`) instead of re-splitting.
  .transform(val => ({
    ...val,
    indexAllowedRoots: parseAllowedRoots(val.INDEX_ALLOWED_ROOTS),
  }));

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
