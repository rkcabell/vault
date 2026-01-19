import fp from "fastify-plugin";
import { S3Client } from "@aws-sdk/client-s3";

declare module "fastify" {
  interface FastifyInstance {
    s3: S3Client; // internal: server-to-server
    s3Presign: S3Client; // public host: presigned URLs for browser
  }
}

export default fp(async app => {
  const { S3_ENDPOINT, S3_PUBLIC_ENDPOINT, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY } =
    app.config;

  const credentials = { accessKeyId: S3_ACCESS_KEY_ID, secretAccessKey: S3_SECRET_ACCESS_KEY };

  // Internal client for container network (minio:9000)
  const s3 = new S3Client({
    region: S3_REGION,
    endpoint: S3_ENDPOINT,
    forcePathStyle: true,
    credentials,
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
});
