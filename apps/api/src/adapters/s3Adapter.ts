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
};

export function createS3Adapter (s3: S3Client) {
  const presignPut = async ({ bucket, key, contentType, expiresSeconds }: PresignPutInput) => {
    const cmd = new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType });
    return getSignedUrl(s3, cmd, { expiresIn: expiresSeconds });
  };

  const presignGet = async ({ bucket, key, expiresSeconds }: PresignGetInput) => {
    const cmd = new GetObjectCommand({ Bucket: bucket, Key: key });
    return getSignedUrl(s3, cmd, { expiresIn: expiresSeconds });
  };

  const getObjectStream = async ({ bucket, key }: GetObjectStreamInput): Promise<GetObjectResult | null> => {
    try {
      const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const body = res.Body;
      if (!body) return null;
      return { body: body as NonNullable<GetObjectCommandOutput["Body"]>, etag: res.ETag ?? null };
    } catch (err) {
      if (isNotFoundError(err)) return null;
      throw err;
    }
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
    deleteIfPresent,
  };
}

export type S3Adapter = ReturnType<typeof createS3Adapter>;
