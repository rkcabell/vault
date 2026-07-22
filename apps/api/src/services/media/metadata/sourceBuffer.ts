import type { Readable } from "node:stream";
import type { FastifyBaseLogger } from "fastify";
import { streamToBuffer } from "../../../lib/streams/toBuffer.js";
import type { StorageAdapter } from "../../../adapters/storage/types.js";

const MAX_SOURCE_BYTES = 50 * 1024 * 1024;

export async function getSourceBuffer ({
  bucket,
  key,
  storage,
  logger,
  mediaId,
}: {
  bucket: string;
  key: string;
  storage: StorageAdapter;
  logger: FastifyBaseLogger;
  mediaId: string;
}): Promise<Buffer | null> {
  try {
    const res = await storage.getObjectStream({ bucket, key });
    if (!res?.body) return null;

    const stream = res.body as unknown as Readable;

    if (typeof res.contentLength === "number" && res.contentLength > MAX_SOURCE_BYTES) {
      stream.destroy();
      return null;
    }

    const buffer = await streamToBuffer(stream);
    if (buffer.length > MAX_SOURCE_BYTES) return null;
    return buffer;
  } catch (err) {
    logger.warn({ err, mediaId }, "[media] metadata source fetch failed");
    return null;
  }
}
