export type RenderHeicThumbnailArgs = {
  image: Uint8Array | Buffer;
  targetWidth?: number;
  maxWidth?: number;
  // kept for backwards-compat but no longer used
  ffmpegPath?: string;
};

/**
 * Convert HEIC/HEIF to PNG using heic-convert (libheif via WASM).
 * Works on all platforms without native ffmpeg HEIF demuxer support.
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
