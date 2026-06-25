import type { MediaWorkerState } from "./types";

export type MediaOverallState = "PENDING" | "READY" | "ERROR" | "UNSUPPORTED";

// Precedence: a real failure (thumb FAILED / text ERROR) outranks anything; then
// still-processing PENDING; then UNSUPPORTED (a neutral terminal skip, not an error);
// otherwise READY.
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
  if (normalizedThumb === "UNSUPPORTED" || normalizedText === "UNSUPPORTED") return "UNSUPPORTED";
  return "READY";
}
