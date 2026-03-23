import type { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  type GetObjectCommandOutput,
  type S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

type PresignPutInput = {
  bucket: string;
  key: string;
  contentType: string;
  expiresSeconds: number;
};

type PresignGetInput = {
  bucket: string;
  key: string;
  expiresSeconds: number;
};

type GetObjectStreamInput = {
  bucket: string;
  key: string;
};

type PutObjectInput = {
  bucket: string;
  key: string;
  body: Readable | Buffer;
  contentType: string;
  contentLength?: number;
};

function isNotFoundError (err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const meta = (err as { $metadata?: { httpStatusCode?: number } }).$metadata;
  if (meta?.httpStatusCode === 404) return true;
  const name = (err as { name?: string }).name;
  return name === "NotFound" || name === "NoSuchKey";
}

export type GetObjectResult = {
  body: NonNullable<GetObjectCommandOutput["Body"]>;
  etag: string | null;
  contentLength: number | null;
};

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

export function createS3Adapter (s3: S3Client) {
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
  }: GetObjectStreamInput): Promise<GetObjectResult | null> => {
    try {
      const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const body = res.Body;
      if (!body) return null;
      return {
        body: body as NonNullable<GetObjectCommandOutput["Body"]>,
        etag: res.ETag ?? null,
        contentLength: res.ContentLength ?? null,
      };
    } catch (err) {
      if (isNotFoundError(err)) return null;
      throw err;
    }
  };

  const putObject = async ({ bucket, key, body, contentType, contentLength }: PutObjectInput) => {
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ...(contentLength !== undefined ? { ContentLength: contentLength } : {}),
      }),
    );
  };

  const deleteIfPresent = async ({ bucket, key }: { bucket: string; key: string }) => {
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    } catch (err) {
      if (!isNotFoundError(err)) {
        throw err;
      }
    }
  };

  return {
    presignPut,
    presignGet,
    getObjectStream,
    putObject,
    deleteIfPresent,
  };
}

export type S3Adapter = ReturnType<typeof createS3Adapter>;
