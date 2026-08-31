/**
 * Collects a stream into a single Buffer.
 */

/**
 * Reads `stream` to its end and returns everything it produced.
 *
 * Accepts either a web ReadableStream or a Node readable stream, because
 * storage adapters return one and file reads return the other.
 */
export async function streamToBuffer (
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
  } else {
    const nodeStream = stream as NodeJS.ReadableStream;
    const chunks: Buffer[] = [];
    return new Promise<Buffer>((resolve, reject) => {
      nodeStream.on("data", (c: Buffer) => chunks.push(c));
      nodeStream.on("end", () => resolve(Buffer.concat(chunks)));
      nodeStream.on("error", reject);
    });
  }
}
