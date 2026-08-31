/**
 * Splits a file's extracted text into the pieces the reader displays and
 * scrolls through one at a time.
 */
import type { PdfTextPage } from "@/services/pdf/extractPdfText.js";

/** One displayable piece of a file's text. `order` is its position in the file, counting from zero. */
export type TextSegment = {
  segmentId: number;
  order: number;
  text: string;
};

const DEFAULT_SEGMENT_LENGTH = 3500;

/**
 * Returns `rawText` split into displayable pieces.
 *
 * A PDF is split at its own page boundaries, so a segment matches a page. Any
 * other text is split at whitespace near `maxLength`, so no word is cut in
 * half.
 */
export function segmentExtractedText (args: {
  rawText: string;
  pages?: PdfTextPage[] | null;
  maxLength?: number;
}): TextSegment[] {
  const { rawText, pages, maxLength = DEFAULT_SEGMENT_LENGTH } = args;

  if (pages && pages.length > 0) {
    return pages.map((page, index) => {
      const isLast = index === pages.length - 1;
      const text = isLast ? (page.text ?? "") : `${page.text ?? ""}\n\n`;
      return { segmentId: index, order: index, text };
    });
  }

  return segmentByLength(rawText, maxLength);
}

// Splits text into pieces of at most `maxLength`, ending each at whitespace
// where one is close enough to the limit.
function segmentByLength (rawText: string, maxLength: number): TextSegment[] {
  const text = rawText ?? "";
  if (!text) return [];

  const segments: TextSegment[] = [];
  let start = 0;
  let order = 0;

  while (start < text.length) {
    const hardEnd = Math.min(start + maxLength, text.length);
    let end = hardEnd;

    if (hardEnd < text.length) {
      const lastWhitespace = findLastWhitespace(text, start, hardEnd);
      if (lastWhitespace > start) {
        end = lastWhitespace + 1;
      }
    }

    const slice = text.slice(start, end);
    segments.push({ segmentId: order, order, text: slice });
    order += 1;
    start = end;
  }

  return segments;
}

// Returns the index of the last whitespace character before `end`, or -1 if
// the whole span from `start` is unbroken.
function findLastWhitespace (text: string, start: number, end: number): number {
  for (let i = end - 1; i > start; i -= 1) {
    if (/\s/.test(text[i])) return i;
  }
  return -1;
}
