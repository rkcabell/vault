import type { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type {
  DeleteObjectInput,
  GetObjectInput,
  GetObjectResult,
  ObjectExistsInput,
  PresignGetInput,
  PresignPutInput,
  PutObjectInput,
  StorageAdapter,
  StorageUsage,
  UsageInput,
} from "./storage/types.js";

function isNotFoundError (err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const meta = (err as { $metadata?: { httpStatusCode?: number } }).$metadata;
  if (meta?.httpStatusCode === 404) return true;
  const name = (err as { name?: string }).name;
  return name === "NotFound" || name === "NoSuchKey";
}

function toPublicPresignedUrl (signedUrl: string): string {
  const publicEndpoint = process.env.S3_PUBLIC_ENDPOINT;
  if (!publicEndpoint) return signedUrl;

  // Example:
  // signedUrl:      http://minio:9000/bucket/key?...sig...
  // publicEndpoint: http://localhost:9000
  const u = new URL(signedUrl);
  const p = new URL(publicEndpoint);

  u.protocol = p.protocol;
  u.host = p.host; // includes port
  return u.toString();
}

export function createS3Adapter (s3: S3Client): StorageAdapter {
  const presignPut = async ({ bucket, key, contentType, expiresSeconds }: PresignPutInput) => {
    const cmd = new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType });
    const signed = await getSignedUrl(s3, cmd, { expiresIn: expiresSeconds });
    return toPublicPresignedUrl(signed);
  };

  const presignGet = async ({ bucket, key, expiresSeconds }: PresignGetInput) => {
    const cmd = new GetObjectCommand({ Bucket: bucket, Key: key });
    const signed = await getSignedUrl(s3, cmd, { expiresIn: expiresSeconds });
    return toPublicPresignedUrl(signed);
  };

  const getObjectStream = async ({
    bucket,
    key,
  }: GetObjectInput): Promise<GetObjectResult | null> => {
    try {
      const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const body = res.Body;
      if (!body) return null;
      return {
        body: body as Readable,
        etag: res.ETag ?? null,
        contentLength: res.ContentLength ?? null,
      };
    } catch (err) {
      if (isNotFoundError(err)) return null;
      throw err;
    }
  };

  const putObject = async ({ bucket, key, body, contentType, contentLength, cacheControl }: PutObjectInput) => {
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ...(contentLength !== undefined ? { ContentLength: contentLength } : {}),
        ...(cacheControl !== undefined ? { CacheControl: cacheControl } : {}),
      }),
    );
  };

  const deleteIfPresent = async ({ bucket, key }: DeleteObjectInput) => {
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    } catch (err) {
      if (!isNotFoundError(err)) {
        throw err;
      }
    }
  };

  const objectExists = async ({ bucket, key }: ObjectExistsInput): Promise<boolean> => {
    try {
      await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return true;
    } catch (err) {
      if (isNotFoundError(err)) return false;
      throw err;
    }
  };

  const usage = async ({ bucket }: UsageInput): Promise<StorageUsage> => {
    let sizeBytes = 0n;
    let objectCount = 0;
    let continuationToken: string | undefined;
    do {
      const res = await s3.send(
        new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: continuationToken }),
      );
      for (const obj of res.Contents ?? []) {
        sizeBytes += BigInt(obj.Size ?? 0);
        objectCount++;
      }
      continuationToken = res.NextContinuationToken;
    } while (continuationToken);
    return { sizeBytes: Number(sizeBytes), objectCount };
  };

  return {
    presignPut,
    presignGet,
    getObjectStream,
    putObject,
    deleteIfPresent,
    objectExists,
    usage,
  };
}

/** @deprecated Use `StorageAdapter` from `./storage/types.js`. Retained as an alias for callers. */
export type S3Adapter = StorageAdapter;
