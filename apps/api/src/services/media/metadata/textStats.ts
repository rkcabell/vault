import type { TextStats } from "./types.js";

export function buildTextStats (
  document?: { rawText?: string | null; pages?: unknown | null } | null,
): TextStats | null {
  if (!document?.rawText) return null;

  const rawText = document.rawText;
  const totalChars = rawText.length;
  if (totalChars === 0) return null;

  const words = rawText.match(/\S+/g) ?? [];
  const totalWords = words.length;

  const pages = Array.isArray(document.pages) ? (document.pages as Array<{ numChars?: number }>) : [];
  const pageCount = pages.length || null;
  const pagesWithText =
    pageCount !== null ? pages.filter(page => (page.numChars ?? 0) > 0).length : null;

  const avgCharsPerPage =
    pageCount && pageCount > 0 ? Math.round(totalChars / pageCount) : null;
  const avgWordsPerPage =
    pageCount && pageCount > 0 ? Math.round(totalWords / pageCount) : null;

  return {
    totalChars,
    totalWords,
    pageCount,
    pagesWithText,
    avgCharsPerPage,
    avgWordsPerPage,
  } satisfies TextStats;
}
