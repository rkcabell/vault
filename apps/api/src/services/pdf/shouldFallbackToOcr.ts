/**
 * Decides whether a PDF needs to be read by optical character recognition
 * because the text could not simply be copied out of it.
 */
export const MIN_PAGE_CHARS = 20;

/**
 * True if `args` describes a PDF whose text has to be recognized from the page
 * images rather than read directly.
 *
 * A PDF that is a picture of a document carries almost no text of its own.
 * Reporting no pages counts as needing recognition, since nothing could be
 * read from it.
 */
export function shouldFallbackToOcr (args: {
  totalChars: number;
  pagesWithText: number;
  numPages: number;
}): boolean {
  const { totalChars, pagesWithText, numPages } = args;

  if (numPages <= 0) return true;

  // Barely any text at all across the whole document.
  if (totalChars < 10) return true;

  // Most pages carry no text, which is what a scanned document looks like.
  const ratio = pagesWithText / numPages;
  if (ratio < 0.5) return true;

  return false;
}
