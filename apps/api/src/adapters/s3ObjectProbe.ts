import { HeadObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { setTimeout as delay } from "node:timers/promises";

export async function waitUntilObjectExists (
  s3: S3Client,
  bucket: string,
  key: string,
  opts?: { maxTries?: number; baseDelayMs?: number; sleep?: (ms: number) => Promise<unknown> },
): Promise<boolean> {
  const maxTries = opts?.maxTries ?? 4;
  const baseDelayMs = opts?.baseDelayMs ?? 1000;
  const sleep = opts?.sleep ?? delay;

  for (let i = 0; i < maxTries; i++) {
    try {
      await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return true;
    } catch {
      await sleep(baseDelayMs * (i + 1));
    }
  }
  return false;
}
