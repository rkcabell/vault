import type { PrismaClient } from "@prisma/client";
import type { PdfTextPage } from "../services/pdf/extractPdfText.js";
import type { TextSource } from "../lib/text/processTextJob.js";

export class DocumentRepository {
  constructor(private readonly prisma: PrismaClient) {}

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
