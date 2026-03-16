import type { Logger } from "pino";
import type { MediaRepository } from "../repositories/mediaRepository.js";
import { STALL_THRESHOLD_MINUTES } from "../lib/workerStateMachine.js";

const STALL_ERROR_MESSAGE = (minutes: number) =>
  `Job stalled — no completion within ${minutes} minutes`;

/**
 * Finds media records whose thumbState or textState has been stuck at PENDING
 * longer than `thresholdMinutes` and marks them terminal:
 *   thumbState PENDING → FAILED
 *   textState  PENDING → ERROR
 *
 * This covers two failure modes:
 *   1. Worker crashed without writing a terminal state (lost job).
 *   2. All retries exhausted on transient errors without the failure handler
 *      firing (e.g., the worker process was killed mid-retry).
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

  if (thumbIds.length) {
    const count = await repo.markThumbStalled(thumbIds, STALL_ERROR_MESSAGE(thresholdMinutes));
    logger.warn({ count, mediaIds: thumbIds }, "stall-detection: marked thumb jobs FAILED");
  }

  if (textIds.length) {
    const count = await repo.markTextStalled(textIds);
    logger.warn({ count, mediaIds: textIds }, "stall-detection: marked text jobs ERROR");
  }
}
