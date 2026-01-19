// Lightweight S3 client singleton that works with AWS or MinIO.
import { S3Client } from "@aws-sdk/client-s3";

const region = process.env.S3_REGION ?? "us-east-1";

function makeClient (endpoint?: string) {
  const hasEndpoint = !!endpoint;
  return new S3Client({
    region,
    endpoint: endpoint || undefined,
    forcePathStyle: hasEndpoint, // MinIO + many S3-compatible stores need this
    credentials:
      process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY
        ? {
            accessKeyId: process.env.S3_ACCESS_KEY_ID!,
            secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
          }
        : undefined,
  });
}

// Used for API/worker -> MinIO calls from inside Docker network
export const s3 = makeClient(process.env.S3_ENDPOINT);

// Used ONLY for generating presigned URLs returned to the browser
// (must match the hostname the browser will actually use, e.g. http://localhost:9000)
export const s3Presign = makeClient(process.env.S3_PUBLIC_ENDPOINT);
