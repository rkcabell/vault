import type { MediaWorkerState } from "./types";

export type MediaOverallState = "PENDING" | "READY" | "ERROR";

export function deriveOverallState(
  thumbState?: MediaWorkerState | null,
  textState?: MediaWorkerState | null,
): MediaOverallState {
  const normalizedThumb = thumbState ?? "PENDING";
  const normalizedText = textState ?? "PENDING";

  if (
    normalizedThumb === "ERROR" ||
    normalizedThumb === "FAILED" ||
    normalizedText === "ERROR" ||
    normalizedText === "FAILED"
  ) {
    return "ERROR";
  }
  if (normalizedThumb === "PENDING" || normalizedText === "PENDING") return "PENDING";
  return "READY";
}
