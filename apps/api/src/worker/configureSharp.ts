import type { Logger } from "pino";

/**
 * Pins libvips' thread pool before any thumbnail is rendered. Sharp otherwise
 * gives every pipeline a pool the size of the core count, so a worker running N
 * jobs runs N x cores threads over the same cores.
 */

/**
 * Sets the libvips pool to one thread per pipeline, leaving BullMQ to own
 * parallelism. `SHARP_CONCURRENCY` overrides that, and 0 restores sharp's own
 * default. Must be awaited: the setting is global to the sharp module, and
 * reaches only the pipelines created after it takes effect.
 */
export async function configureSharp (logger?: Logger): Promise<void> {
  const raw = process.env.SHARP_CONCURRENCY;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  const concurrency = Number.isFinite(parsed) && parsed >= 0 ? parsed : 1;

  // Imported here rather than at module load: sharp pulls in a native binary,
  // and only a process that renders should pay for it.
  try {
    const { default: sharp } = await import("sharp");
    sharp.concurrency(concurrency);
    logger?.info(
      { sharpConcurrency: sharp.concurrency(), requested: concurrency },
      "libvips thread pool pinned",
    );
  } catch (err) {
    // A missing native binary is reported per job by the thumbnailer, rather
    // than taking the worker down at boot.
    logger?.warn({ err }, "could not configure sharp concurrency");
  }
}
