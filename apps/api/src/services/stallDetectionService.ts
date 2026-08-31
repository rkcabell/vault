import type { Logger } from "pino";
import type { MediaRepository } from "../repositories/mediaRepository.js";
import { STALL_THRESHOLD_MINUTES } from "../lib/workerStateMachine.js";

/**
 * Closes out derivative jobs that never reported back, so a row does not sit at
 * PENDING forever after a worker died part-way through one.
 */

const STALL_ERROR_MESSAGE = (minutes: number) =>
  `Job stalled — no completion within ${minutes} minutes`;

/**
 * Marks every row stuck at PENDING for longer than `thresholdMinutes` as
 * finished: thumbnails and hashes become FAILED, text becomes ERROR.
 */
export async function markStalledJobs (
  repo: MediaRepository,
  logger: Logger,
  thresholdMinutes = STALL_THRESHOLD_MINUTES,
): Promise<void> {
  const staleBefore = new Date(Date.now() - thresholdMinutes * 60 * 1000);
  const stalled = await repo.findStalledMedia(staleBefore);

  if (!stalled.length) return;

  const thumbIds = stalled.filter(m => m.thumbState === "PENDING").map(m => m.id);
  const textIds = stalled.filter(m => m.textState === "PENDING").map(m => m.id);
  const hashIds = stalled.filter(m => m.hashState === "PENDING").map(m => m.id);

  if (thumbIds.length) {
    const count = await repo.markThumbStalled(thumbIds, STALL_ERROR_MESSAGE(thresholdMinutes));
    logger.warn({ count, mediaIds: thumbIds }, "stall-detection: marked thumb jobs FAILED");
  }

  if (textIds.length) {
    const count = await repo.markTextStalled(textIds);
    logger.warn({ count, mediaIds: textIds }, "stall-detection: marked text jobs ERROR");
  }

  if (hashIds.length) {
    const count = await repo.markHashStalled(hashIds);
    logger.warn({ count, mediaIds: hashIds }, "stall-detection: marked hash jobs FAILED");
  }
}
