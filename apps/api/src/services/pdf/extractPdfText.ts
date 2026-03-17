import { loadPdfJs, getStandardFontDataUrl } from "./loadPdfJs.js";
import { MIN_PAGE_CHARS, shouldFallbackToOcr } from "./shouldFallbackToOcr.js";
import type { DocumentInitParameters } from "pdfjs-dist/types/src/display/api";

export type PdfTextPage = { pageNumber: number; text: string; numChars: number };

/**
 * Extract text from a PDF buffer using pdf.js.
 */
export async function extractPdfText (
  input: Uint8Array | Buffer,
  opts?: { onProgress?: (progress: { current: number; total: number }) => void },
) {
  const pdfjs = await loadPdfJs();
  const data = toPdfJsData(input);
  const onProgress = opts?.onProgress;

  const standardFontDataUrl = getStandardFontDataUrl();
  const init: DocumentInitParameters & { disableWorker?: boolean } = {
    data,
    disableWorker: true,
    ...(standardFontDataUrl ? { standardFontDataUrl } : {}),
  };

  const loadingTask = pdfjs.getDocument(init);

  const doc = await loadingTask.promise;

  // After this many consecutive leading blank pages (0 chars) we know
  // shouldFallbackToOcr will return true, so there is no point scanning further.
  const EARLY_EXIT_BLANK_PAGES = 3;

  let destroyed = false;
  try {
    const pages: PdfTextPage[] = [];
    let totalChars = 0;
    let pagesWithText = 0;
    if (onProgress) {
      onProgress({ current: 0, total: doc.numPages });
    }

    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();

      // pdf.js text items usually have `str` and sometimes `hasEOL`
      const items = content.items as Array<{
        str?: string;
        hasEOL?: boolean;
        transform?: number[];
        height?: number;
      }>;

      // Preserve paragraph breaks while still removing NULs.
      const text = stripNulls(buildTextWithParagraphs(items))
        .replace(/[ \t\f\v]+/g, " ")
        .replace(/[ \t\f\v]*\n[ \t\f\v]*/g, "\n")
        .trim();

      const numChars = text.length;
      pages.push({ pageNumber, text, numChars });

      totalChars += numChars;
      if (numChars >= MIN_PAGE_CHARS) pagesWithText += 1;
      if (onProgress) {
        onProgress({ current: pageNumber, total: doc.numPages });
      }

      // Early exit: if the first N pages are all blank, needsOcr will be true
      // regardless of remaining pages — no need to scan the rest.
      if (pageNumber >= EARLY_EXIT_BLANK_PAGES && totalChars === 0) {
        break;
      }
    }

    const fullText = stripNulls(pages.map(p => p.text).join("\n\n")).trim();

    // Keep totals consistent with what you actually persist/use.
    // totalChars above is already based on sanitized page text.
    const needsOcr = shouldFallbackToOcr({
      totalChars,
      pagesWithText,
      numPages: doc.numPages,
    });

    return {
      pages,
      fullText,
      totalChars,
      pagesWithText,
      numPages: doc.numPages,
      needsOcr,
    };
  } finally {
    try {
      await doc.destroy();
      destroyed = true;
    } catch {}
    void destroyed;
  }
}

/**
 * Postgres (and Prisma->Postgres) cannot store NUL (\0) in TEXT.
 * pdf.js extraction can sometimes include embedded NULs due to font/encoding artifacts.
 */
function stripNulls (s: string): string {
  return s.includes("\0") ? s.replace(/\0/g, "") : s;
}

type TextItem = {
  str?: string;
  hasEOL?: boolean;
  transform?: number[];
  height?: number;
};

type Line = {
  text: string;
  y: number | null;
  height: number | null;
};

function buildTextWithParagraphs (items: TextItem[]): string {
  const lines = buildLines(items);
  return mergeLinesIntoParagraphs(lines);
}

function buildLines (
  items: Array<{ str?: string; hasEOL?: boolean; transform?: number[]; height?: number }>,
): Line[] {
  const itemsWithText = items.filter(item => (item.str ?? "").length > 0);
  const positioned = itemsWithText.filter(item => (item.transform?.length ?? 0) >= 6);
  const usePositions = positioned.length / Math.max(itemsWithText.length, 1) >= 0.6;

  const lines: Line[] = [];
  let lineParts: string[] = [];
  let lineY: number | null = null;
  let lineHeight: number | null = null;

  const flush = () => {
    if (lineParts.length) {
      lines.push({ text: lineParts.join(" "), y: lineY, height: lineHeight });
      lineParts = [];
    }
    lineY = null;
    lineHeight = null;
  };

  for (const item of items) {
    const raw = item.str ?? "";
    const str = stripNulls(raw);
    if (!str) {
      if (!usePositions && item.hasEOL) flush();
      continue;
    }

    const pos = usePositions ? getItemPosition(item) : null;
    if (pos) {
      if (lineY !== null) {
        const threshold = getLineThreshold(lineHeight, pos.height);
        if (threshold !== null && Math.abs(pos.y - lineY) > threshold) {
          flush();
        }
      }
      if (lineY === null) {
        lineY = pos.y;
      }
      if (pos.height !== null && (lineHeight === null || pos.height > lineHeight)) {
        lineHeight = pos.height;
      }
    }

    lineParts.push(str);

    if ((!usePositions || !pos) && item.hasEOL) {
      flush();
    }
  }

  flush();
  return lines;
}

function getItemPosition (item: {
  transform?: number[];
  height?: number;
}): { y: number; height: number | null } | null {
  const transform = item.transform;
  if (!transform || transform.length < 6) return null;
  const y = transform[5];
  if (!Number.isFinite(y)) return null;
  const height =
    typeof item.height === "number" && Number.isFinite(item.height) ? Math.abs(item.height) : null;
  return { y, height };
}

function getLineThreshold (lineHeight: number | null, itemHeight: number | null): number {
  const base = Math.max(lineHeight ?? 0, itemHeight ?? 0);
  return base > 0 ? base * 0.6 : 2;
}

function mergeLinesIntoParagraphs (lines: Line[]): string {
  if (!lines.length) return "";

  const gapBaseline = getBaselineLineGap(lines);
  if (gapBaseline === null) {
    return lines.map(line => line.text).join("\n");
  }

  const paragraphGap = Math.max(gapBaseline * 1.6, gapBaseline + 2);
  const paragraphs: string[] = [];
  let current = lines[0].text;

  for (let i = 1; i < lines.length; i += 1) {
    const gap = getLineGap(lines[i - 1], lines[i]);
    if (gap !== null && gap > paragraphGap) {
      paragraphs.push(current);
      current = lines[i].text;
    } else {
      current = joinLineText(current, lines[i].text);
    }
  }

  paragraphs.push(current);
  return paragraphs.join("\n");
}

function joinLineText (current: string, next: string): string {
  if (current.endsWith("-")) {
    return `${current.slice(0, -1)}${next}`;
  }
  if (current.endsWith("\u00ad")) {
    return `${current.slice(0, -1)}${next}`;
  }
  return `${current} ${next}`;
}

function getLineGap (prev: Line, next: Line): number | null {
  if (prev.y === null || next.y === null) return null;
  const gap = Math.abs(prev.y - next.y);
  return Number.isFinite(gap) ? gap : null;
}

function getBaselineLineGap (lines: Line[]): number | null {
  const gaps: number[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const gap = getLineGap(lines[i - 1], lines[i]);
    if (gap !== null) gaps.push(gap);
  }
  if (!gaps.length) return null;
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  return gaps.length % 2 === 0 ? (gaps[mid - 1] + gaps[mid]) / 2 : gaps[mid];
}

function toPdfJsData (input: Uint8Array | Buffer): Uint8Array {
  // Copy into a fresh ArrayBuffer — pdf.js may transfer (detach) the buffer it
  // receives, so a view into Node.js's shared pool would cause
  // "Unable to deserialize cloned data" on subsequent access.
  return new Uint8Array(input);
}
