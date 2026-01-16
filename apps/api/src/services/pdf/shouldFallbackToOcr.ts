export const MIN_PAGE_CHARS = 20;

// Heuristics:
// - if total extracted chars are tiny, likely image-only scan
// - if most pages have near-zero text, likely scan
export function shouldFallbackToOcr (args: {
  totalChars: number;
  pagesWithText: number;
  numPages: number;
}): boolean {
  const { totalChars, pagesWithText, numPages } = args;

  if (numPages <= 0) return true;

  // Extremely low total text: treat as needing OCR
  if (totalChars < 10) return true;

  const ratio = pagesWithText / numPages;
  if (ratio < 0.5) return true;

  return false;
}
