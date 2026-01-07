// Lightweight S3 client singleton that works with AWS or MinIO.
import { S3Client } from "@aws-sdk/client-s3";

const endpoint = process.env.S3_ENDPOINT; // e.g. http://localhost:9000 (MinIO)
const region = process.env.S3_REGION ?? "us-east-1";

export const s3 = new S3Client({
  region,
  endpoint: endpoint || undefined,
  forcePathStyle: !!endpoint, // MinIO + many S3-compatible stores need this
  credentials:
    process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY
      ? {
          accessKeyId: process.env.S3_ACCESS_KEY_ID!,
          secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
        }
      : undefined,
});
