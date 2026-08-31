/**
 * Converts a photo taken by a modern phone into a format the thumbnail
 * renderer can work with.
 */
export type RenderHeicThumbnailArgs = {
  image: Uint8Array | Buffer;
  targetWidth?: number;
  maxWidth?: number;
  /** Ignored. Kept so existing callers still compile. */
  ffmpegPath?: string;
};

/**
 * Returns `image` re-encoded as a PNG.
 *
 * The conversion runs in WebAssembly, so no HEIF support is needed from the
 * system's own media libraries. Failure raises an error whose message begins
 * HEIC_THUMBNAIL_FAILED.
 */
export async function renderHeicThumbnail(args: RenderHeicThumbnailArgs): Promise<Buffer> {
  const { image } = args;

  try {
    const { default: convert } = await import("heic-convert");
    const outputBuffer = await convert({
      buffer: Buffer.from(image),
      format: "PNG",
    });

    const png = Buffer.from(outputBuffer);
    if (!png || png.length === 0) throw new Error("HEIC_CONVERT_RETURNED_EMPTY_BUFFER");
    return png;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`HEIC_THUMBNAIL_FAILED: ${msg}`);
  }
}
