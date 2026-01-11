import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";

async function streamToBuffer(
  stream: ReadableStream | NodeJS.ReadableStream,
): Promise<Buffer> {
  if ("getReader" in (stream as ReadableStream)) {
    const reader = (stream as ReadableStream).getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value as Uint8Array);
    }
    return Buffer.concat(chunks);
  }

  const nodeStream = stream as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  return new Promise<Buffer>((resolve, reject) => {
    nodeStream.on("data", (c: Buffer) => chunks.push(c));
    nodeStream.on("end", () => resolve(Buffer.concat(chunks)));
    nodeStream.on("error", reject);
  });
}

export async function getObjectBuffer(
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
