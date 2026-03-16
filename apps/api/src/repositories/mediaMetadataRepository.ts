import type { PrismaClient } from "@prisma/client";

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
