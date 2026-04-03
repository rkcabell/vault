import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type RenderVideoThumbnailArgs = {
  video?: Uint8Array | Buffer;
  /** Pre-written temp file path — when provided, the writeFile step is skipped. Caller is responsible for cleanup. */
  videoPath?: string;
  targetWidth?: number;
  maxWidth?: number;
  seekSeconds?: number;
  ffmpegPath?: string;
};

/**
 * Render a single-frame thumbnail from a video using ffmpeg.
 * Returns a PNG buffer suitable for passing into the sharp pipeline.
 *
 * When `videoPath` is provided the function skips writing the source file and
 * uses the pre-existing path directly — useful when the caller has already
 * streamed the file to disk (avoids an extra buffer copy).
 */
export async function renderVideoThumbnail (args: RenderVideoThumbnailArgs): Promise<Buffer> {
  const { video, videoPath, maxWidth = 2000, targetWidth = 1200, seekSeconds = 1, ffmpegPath } = args;

  const ffmpegBinary = ffmpegPath ?? process.env.FFMPEG_PATH ?? "ffmpeg";
  // Always create a workdir for the output PNG. When videoPath is provided we
  // skip writing the input file (it's already on disk), but we still need a
  // separate dir for the output so cleanup is straightforward.
  const workdir = await mkdtemp(join(tmpdir(), "vault-thumb-"));
  const inputPath = videoPath ?? join(workdir, "input.mp4");
  const outputPath = join(workdir, "thumb.png");

  try {
    if (!videoPath && video) {
      await writeFile(inputPath, Buffer.from(video));
    }

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
    // videoPath dir cleanup is the caller's responsibility
  }
}
