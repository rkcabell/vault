/**
 * Turns a Redis connection URL into the settings object BullMQ expects.
 */
import { type ConnectionOptions } from "bullmq";

/** Reads host, port, credentials and database number out of `url`. A `rediss:` URL turns TLS on. */
export function buildRedisConnection (url: string): ConnectionOptions {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 6379,
    username: parsed.username || undefined,
    password: parsed.password || undefined,
    db: parsed.pathname ? Number(parsed.pathname.replace("/", "")) || 0 : 0,
    tls: parsed.protocol === "rediss:" ? {} : undefined,
  };
}
