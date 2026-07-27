import crypto from "node:crypto";
import { createReadStream } from "node:fs";

/**
 * Streaming sha256 of a file on disk, or null if it cannot be read.
 *
 * Shared by the live watcher and the reconcile sweep, which both use it for the
 * same narrow purpose: breaking a tie between move candidates that cheap
 * metadata could not separate (see lib/media/matchIdentity). It streams rather
 * than buffering because the files it is pointed at are arbitrarily large, and
 * it swallows read errors because a file that vanished mid-hash simply means
 * "no match", not "abort the sweep".
 */
export async function hashFileStreaming (absPath: string): Promise<string | null> {
  try {
    const hash = crypto.createHash("sha256");
    for await (const chunk of createReadStream(absPath)) hash.update(chunk as Buffer);
    return hash.digest("hex");
  } catch {
    return null;
  }
}
