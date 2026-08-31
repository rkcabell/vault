import crypto from "node:crypto";
import { createReadStream } from "node:fs";

/**
 * Hashes a file on disk, for the one thing that needs it: telling two move
 * candidates apart when size and modified time could not.
 */

/**
 * Returns a file's sha256, or null when it cannot be read. It streams rather
 * than buffering, because the files it is pointed at can be any size. A read
 * error returns null too: a file that disappeared mid-hash means no match, not
 * a failed sweep.
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
