/**
 * Validates the process environment at startup and hands the rest of the app one
 * typed config object. A missing or malformed value stops the boot, so a bad
 * deployment fails immediately instead of at the first request that needs it.
 */

import fp from "fastify-plugin";
import { z } from "zod";
import { parseAllowedRoots } from "../lib/media/indexRoots.js";
import { parseAllowedOrigins } from "../lib/http/originCheck.js";

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    HOST: z.string().default("127.0.0.1"),
    PORT: z.coerce.number().int().positive().default(8000),
    CORS_ORIGIN: z.string().default("http://localhost:3000"),

    // Origins allowed to make state-changing requests, comma-separated.
    // Falls back to CORS_ORIGIN. `*` turns the check off entirely.
    ALLOWED_ORIGINS: z.string().optional(),

    // Trust X-Forwarded-For only when every request reaches the API through a
    // proxy. An unproxied caller sets the header itself and so picks its own
    // rate-limit bucket.
    TRUST_PROXY: z
      .string()
      .optional()
      .transform(v => v === "true"),

    POSTGRES_URL: z.string().url().optional(),
    JWT_SECRET: z.string().min(32),
    JWT_REFRESH_SECRET: z.string().min(32),
    // Any `jsonwebtoken` expiresIn string.
    // The access lifetime bounds how long a revoked session keeps working.
    JWT_ACCESS_TTL: z.string().default("15m"),
    JWT_REFRESH_TTL: z.string().default("7d"),

    // Holds every managed original and thumbnail.
    // May point at a local drive or a mounted network share.
    STORAGE_FS_PATH: z.string().min(1).default("/data/vault"),
    // The filesystem backend ignores this. Service calls still thread it through.
    STORAGE_BUCKET: z.string().default("vault-media"),
    REDIS_URL: z.string().url(),

    // Absolute directories Vault may walk and read originals from without
    // copying them, comma-separated. Unset disables in-place indexing.
    INDEX_ALLOWED_ROOTS: z.string().optional(),

    DISABLE_REGISTRATION: z
      .string()
      .optional()
      .transform(v => v === "true"),

    // Whether the server may open a native file manager (Explorer/Finder) on its
    // own machine. Set it to "false" for remote or multi-user deployments, where
    // the server's desktop is not the user's.
    //
    // Compared as a string because z.coerce.boolean() reads "false" as true.
    LOCAL_EXPLORER: z
      .string()
      .optional()
      .transform(v => v !== "false"),
  })
  // `csrfAllowedOrigins` is null when the origin check is switched off.
  .transform(val => ({
    ...val,
    indexAllowedRoots: parseAllowedRoots(val.INDEX_ALLOWED_ROOTS),
    csrfAllowedOrigins: parseAllowedOrigins(val.ALLOWED_ORIGINS ?? val.CORS_ORIGIN),
  }))
  // An origin list that parses to nothing would reject every mutation the UI makes.
  .refine(val => val.csrfAllowedOrigins === null || val.csrfAllowedOrigins.length > 0, {
    message:
      "ALLOWED_ORIGINS (or CORS_ORIGIN, which it falls back to) must list at least " +
      "one absolute origin such as https://vault.example.com, or `*` to disable the check",
    path: ["ALLOWED_ORIGINS"],
  });

declare module "fastify" {
  interface FastifyInstance {
    config: z.infer<typeof EnvSchema>;
  }
}

/** Validate the environment and expose the result as `app.config`. */
export const configPlugin = fp(async (app) => {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    app.log.error(parsed.error.format(), "Invalid environment configuration");
    throw new Error("Invalid environment configuration");
  }
  app.decorate("config", parsed.data);
});
