/**
 * Stores the details read out of a file itself, such as camera settings or a
 * document's author.
 */
import type { PrismaClient } from "@prisma/client";

/** Reads and writes the extracted details for one media item, held as free-form JSON. */
export class MediaMetadataRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async upsert(mediaId: string, data: object): Promise<void> {
    await this.prisma.mediaExtractedMetadata.upsert({
      where: { mediaId },
      create: { mediaId, data, extractedAt: new Date() },
      update: { data, extractedAt: new Date() },
    });
  }

  async find(mediaId: string): Promise<{ data: unknown } | null> {
    return this.prisma.mediaExtractedMetadata.findUnique({
      where: { mediaId },
      select: { data: true },
    });
  }
}
