import { loadPdfJs } from "./loadPdfJs.js";
import { MIN_PAGE_CHARS, shouldFallbackToOcr } from "./shouldFallbackToOcr.js";

export type PdfTextPage = { pageNumber: number; text: string; numChars: number };

/**
 * Extract text from a PDF buffer using pdf.js.
 */
export async function extractPdfText (input: Uint8Array | Buffer) {
  const pdfjs = await loadPdfJs();
  const data = toPdfJsData(input);

  const loadingTask = pdfjs.getDocument({
    data,
    disableWorker: true,
  });

  const doc = await loadingTask.promise;

  let destroyed = false;
  try {
    const pages: PdfTextPage[] = [];
    let totalChars = 0;
    let pagesWithText = 0;

    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();

      // pdf.js text items usually have `str`
      const items = content.items as Array<{ str?: string }>;

      // Strip NULs at the item level to prevent them from propagating
      // into the joined string.
      const text = stripNulls(items.map(item => stripNulls(item.str ?? "")).join(" "))
        .replace(/\s+/g, " ")
        .trim();

      const numChars = text.length;
      pages.push({ pageNumber, text, numChars });

      totalChars += numChars;
      if (numChars >= MIN_PAGE_CHARS) pagesWithText += 1;
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
 * Postgres (and Prisma->Postgres) cannot store NUL (\u0000) in TEXT.
 * pdf.js extraction can sometimes include embedded NULs due to font/encoding artifacts.
 */
function stripNulls (s: string): string {
  // Fast path: avoid regex work when possible
  return s.includes("\u0000") ? s.replace(/\u0000/g, "") : s;
}

function toPdfJsData (input: Uint8Array | Buffer): Uint8Array {
  if (Buffer.isBuffer(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  return input;
}
