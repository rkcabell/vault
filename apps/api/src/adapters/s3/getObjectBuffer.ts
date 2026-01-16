import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { streamToBuffer } from "../../lib/streams/toBuffer.js";

export async function getObjectBuffer (
  s3: S3Client,
  bucket: string,
  key: string,
): Promise<Buffer | null> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = res.Body;
    if (!body) return null;
    return streamToBuffer(body as NodeJS.ReadableStream);
  } catch {
    return null;
  }
}
