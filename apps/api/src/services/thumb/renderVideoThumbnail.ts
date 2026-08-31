/**
 * Grabs a still frame from a video to use as its thumbnail.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type RenderVideoThumbnailArgs = {
  video?: Uint8Array | Buffer;
  /** The video already on disk. Supplying it skips writing one, and the caller deletes it afterwards. */
  videoPath?: string;
  targetWidth?: number;
  maxWidth?: number;
  seekSeconds?: number;
  ffmpegPath?: string;
};

/**
 * Returns one frame of a video as a PNG, ready for the image pipeline.
 *
 * The frame is taken `seekSeconds` in, because the very first frame of a video
 * is often blank. Failure raises an error whose message begins
 * FFMPEG_THUMBNAIL_FAILED.
 */
export async function renderVideoThumbnail (args: RenderVideoThumbnailArgs): Promise<Buffer> {
  const { video, videoPath, maxWidth = 2000, targetWidth = 1200, seekSeconds = 1, ffmpegPath } = args;

  const ffmpegBinary = ffmpegPath ?? process.env.FFMPEG_PATH ?? "ffmpeg";
  // A working folder is made even when the video is already on disk, because
  // the PNG still has to be written somewhere this function can delete.
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
    // A video the caller placed on disk is the caller's to delete.
  }
}
