/**
 * Stores the text extracted from a file, and keeps the full-text search index
 * for it up to date.
 */
import type { PrismaClient } from "@prisma/client";
import type { PdfTextPage } from "../services/pdf/extractPdfText.js";
import type { TextSource } from "../lib/text/processTextJob.js";

/** Reads and writes the extracted text belonging to one media item. */
export class DocumentRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Stores the text for one item, replacing anything already held for it, and
   * rebuilds that item's search index entry.
   *
   * The search index is written by hand because Prisma cannot describe a text
   * search column. Words are indexed as written, with no stemming, so a search
   * for "run" does not match "running".
   */
  async upsertDocument (args: {
    mediaId: string;
    rawText: string;
    pages: PdfTextPage[] | null;
    textSource: TextSource;
  }) {
    const { mediaId, rawText, pages, textSource } = args;
    await this.prisma.document.upsert({
      where: { mediaId },
      update: { rawText, pages: pages ?? [], textSource },
      create: { mediaId, rawText, pages: pages ?? [], textSource },
    });
    await this.prisma.$executeRaw`
      UPDATE "Document"
      SET "searchVector" = to_tsvector('simple', ${rawText})
      WHERE "mediaId" = ${mediaId}
    `;
  }
}
