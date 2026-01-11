export const MIN_TOTAL_CHARS = 200;
export const MIN_PAGE_CHARS = 20;
export const MIN_TEXT_PAGE_RATIO = 0.2;

export function shouldFallbackToOcr(args: {
  totalChars: number;
  pagesWithText: number;
  numPages: number;
}): boolean {
  const minPagesWithText = Math.max(1, Math.ceil(args.numPages * MIN_TEXT_PAGE_RATIO));
  return args.totalChars < MIN_TOTAL_CHARS || args.pagesWithText < minPagesWithText;
}
