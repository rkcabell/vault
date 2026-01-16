import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type RenderVideoThumbnailArgs = {
  video: Uint8Array | Buffer;
  targetWidth?: number;
  maxWidth?: number;
  seekSeconds?: number;
  ffmpegPath?: string;
};

/**
 * Render a single-frame thumbnail from a video using ffmpeg.
 * Returns a PNG buffer suitable for passing into the sharp pipeline.
 */
export async function renderVideoThumbnail (args: RenderVideoThumbnailArgs): Promise<Buffer> {
  const { video, maxWidth = 2000, targetWidth = 1200, seekSeconds = 1, ffmpegPath } = args;

  const ffmpegBinary = ffmpegPath ?? process.env.FFMPEG_PATH ?? "ffmpeg";
  const workdir = await mkdtemp(join(tmpdir(), "vault-thumb-"));
  const inputPath = join(workdir, "input.mp4");
  const outputPath = join(workdir, "thumb.png");

  try {
    await writeFile(inputPath, Buffer.from(video));

    const width = Math.max(16, Math.min(maxWidth, targetWidth));
    const seek = Math.max(0, seekSeconds);

    const ffmpegArgs = [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      seek.toString(),
      "-i",
      inputPath,
      "-frames:v",
      "1",
      "-vf",
      `scale=${width}:-2:flags=lanczos`,
      outputPath,
    ];

    await execFileAsync(ffmpegBinary, ffmpegArgs, { windowsHide: true });

    const png = await readFile(outputPath);
    if (!png || png.length === 0) throw new Error("FFMPEG_RETURNED_EMPTY_THUMBNAIL");
    return png;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`FFMPEG_THUMBNAIL_FAILED: ${msg}`);
  } finally {
    try {
      await rm(workdir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}
