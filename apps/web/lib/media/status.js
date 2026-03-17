export function deriveOverallState(thumbState, textState) {
    const normalizedThumb = thumbState ?? "PENDING";
    const normalizedText = textState ?? "PENDING";
    if (normalizedThumb === "ERROR" ||
        normalizedThumb === "FAILED" ||
        normalizedText === "ERROR" ||
        normalizedText === "FAILED") {
        return "ERROR";
    }
    if (normalizedThumb === "PENDING" || normalizedText === "PENDING")
        return "PENDING";
    return "READY";
}
