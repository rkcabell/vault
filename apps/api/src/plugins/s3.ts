import fp from "fastify-plugin";
import {
  S3Client,
  HeadBucketCommand,
  CreateBucketCommand,
} from "@aws-sdk/client-s3";
import type { FastifyBaseLogger } from "fastify";

declare module "fastify" {
  interface FastifyInstance {
    // Both are undefined in fs mode (the s3 plugin returns early without decorating).
    // Guard all accesses with an app.config.STORAGE_DRIVER === "s3" check.
    s3: S3Client | undefined; // internal: server-to-server
    s3Presign: S3Client | undefined; // public host: presigned URLs for browser
  }
}

function isNotFound (err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const meta = (err as { $metadata?: { httpStatusCode?: number } }).$metadata;
  if (meta?.httpStatusCode === 404) return true;
  const name = (err as { name?: string }).name;
  return name === "NotFound" || name === "NoSuchBucket";
}

function isAlreadyExists (err: unknown): boolean {
  const name = (err && typeof err === "object" ? (err as { name?: string }).name : "") ?? "";
  return name === "BucketAlreadyOwnedByYou" || name === "BucketAlreadyExists";
}

/**
 * Ensure the media bucket exists, creating it on first boot. MinIO returns
 * 404 NoSuchBucket for presigned PUTs when the bucket is missing, so a fresh
 * volume would otherwise 404 the very first upload. Idempotent and best-effort:
 * a transient S3 error here is logged but does not block startup.
 */
async function ensureBucket (s3: S3Client, bucket: string, log: FastifyBaseLogger): Promise<void> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    log.debug({ bucket }, "media bucket exists");
  } catch (err) {
    if (!isNotFound(err)) {
      log.warn({ err, bucket }, "could not verify media bucket; continuing");
      return;
    }
    try {
      await s3.send(new CreateBucketCommand({ Bucket: bucket }));
      log.info({ bucket }, "created media bucket");
    } catch (createErr) {
      if (isAlreadyExists(createErr)) {
        log.debug({ bucket }, "media bucket already exists (created concurrently)");
        return;
      }
      log.warn({ err: createErr, bucket }, "failed to create media bucket; continuing");
    }
  }
}

export default fp(async app => {
  // Filesystem storage mode needs no S3 client — skip entirely so an fs-only
  // deployment doesn't require any S3_* env vars.
  if (app.config.STORAGE_DRIVER !== "s3") {
    app.log.info({ driver: app.config.STORAGE_DRIVER }, "S3 client disabled (filesystem storage)");
    return;
  }

  const { S3_ENDPOINT, S3_PUBLIC_ENDPOINT, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY } =
    app.config;

  // Presence guaranteed by the config superRefine when STORAGE_DRIVER=s3.
  const credentials = {
    accessKeyId: S3_ACCESS_KEY_ID!,
    secretAccessKey: S3_SECRET_ACCESS_KEY!,
  };

  // Internal client for container network (minio:9000)
  const s3 = new S3Client({
    region: S3_REGION,
    endpoint: S3_ENDPOINT,
    forcePathStyle: true,
    credentials,
    // Fail fast on an unreachable endpoint (MinIO down, or broken Docker/WSL2
    // port forwarding) instead of hanging every request and making the whole API
    // appear unresponsive. connectionTimeout bounds only the TCP connect phase,
    // so it never truncates legitimate large uploads/downloads.
    maxAttempts: 2,
    requestHandler: { connectionTimeout: 3000 },
  });

  // Presign client for URLs the BROWSER will use (localhost:9000)
  // Must match the hostname in the final URL, otherwise MinIO returns 403 SignatureDoesNotMatch.
  const s3Presign = new S3Client({
    region: S3_REGION,
    endpoint: S3_PUBLIC_ENDPOINT || S3_ENDPOINT,
    forcePathStyle: true,
    credentials,
  });

  app.decorate("s3", s3);
  app.decorate("s3Presign", s3Presign);

  // Best-effort, time-bounded bucket creation on first boot (so fresh
  // environments don't 404 uploads). Crucially this must NEVER block or fail
  // startup: a misconfigured or unreachable S3 endpoint should degrade storage
  // only, not crash the whole API (which would also take down auth). The await
  // is capped well under Fastify's plugin timeout; the SDK call is swallowed and
  // may complete in the background.
  const BOOT_BUCKET_TIMEOUT_MS = 3000;
  await Promise.race([
    ensureBucket(s3, app.config.S3_BUCKET, app.log).catch(err =>
      app.log.warn({ err }, "ensureBucket failed; continuing"),
    ),
    new Promise<void>(resolve => setTimeout(resolve, BOOT_BUCKET_TIMEOUT_MS)),
  ]);
});
