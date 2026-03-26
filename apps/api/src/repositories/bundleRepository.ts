import { type PrismaClient } from "@prisma/client";

export class BundleRepository {
  constructor (private readonly prisma: PrismaClient) {}

  async listBundles (userId: string, q?: string) {
    const where = q
      ? {
          userId,
          OR: [
            { name: { contains: q, mode: "insensitive" as const } },
            { description: { contains: q, mode: "insensitive" as const } },
            { items: { some: { media: { title: { contains: q, mode: "insensitive" as const } } } } },
            { items: { some: { media: { document: { is: { rawText: { contains: q, mode: "insensitive" as const } } } } } } },
          ],
        }
      : { userId };
    const bundles = await this.prisma.bundle.findMany({
      where,
      orderBy: [{ starredAt: { sort: "asc", nulls: "last" } }, { updatedAt: "desc" }],
      select: {
        id: true,
        name: true,
        description: true,
        starred: true,
        isUnpackedArchive: true,
        sourceMediaId: true,
        coverMediaId: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { items: true } },
        items: {
          orderBy: { order: "asc" },
          take: 1,
          select: { mediaId: true },
        },
      },
    });

    return bundles.map(b => ({
      id: b.id,
      name: b.name,
      description: b.description,
      starred: b.starred,
      itemCount: b._count.items,
      coverMediaId: b.coverMediaId ?? b.items[0]?.mediaId ?? null,
      isUnpackedArchive: b.isUnpackedArchive,
      sourceMediaId: b.sourceMediaId ?? null,
      createdAt: b.createdAt.toISOString(),
      updatedAt: b.updatedAt.toISOString(),
    }));
  }

  async getBundleById (id: string, userId: string) {
    const bundle = await this.prisma.bundle.findFirst({
      where: { id, userId },
      select: {
        id: true,
        name: true,
        description: true,
        starred: true,
        coverMediaId: true,
        isUnpackedArchive: true,
        sourceMediaId: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { items: true } },
        items: {
          orderBy: { order: "asc" },
          select: {
            mediaId: true,
            order: true,
            addedAt: true,
            media: {
              select: {
                title: true,
                mimeType: true,
                sizeBytes: true,
                thumbState: true,
                textState: true,
                thumbnailKey: true,
                tags: true,
              },
            },
          },
        },
      },
    });

    if (!bundle) return null;

    return {
      id: bundle.id,
      name: bundle.name,
      description: bundle.description,
      starred: bundle.starred,
      itemCount: bundle._count.items,
      coverMediaId: bundle.coverMediaId ?? bundle.items[0]?.mediaId ?? null,
      isUnpackedArchive: bundle.isUnpackedArchive,
      sourceMediaId: bundle.sourceMediaId ?? null,
      createdAt: bundle.createdAt.toISOString(),
      updatedAt: bundle.updatedAt.toISOString(),
      items: bundle.items.map(item => ({
        mediaId: item.mediaId,
        order: item.order,
        addedAt: item.addedAt.toISOString(),
        title: item.media.title,
        mimeType: item.media.mimeType,
        sizeBytes: item.media.sizeBytes,
        thumbState: item.media.thumbState,
        textState: item.media.textState,
        thumbnailKey: item.media.thumbnailKey,
        tags: item.media.tags,
      })),
    };
  }

  async setSourceMedia (bundleId: string, mediaId: string) {
    await this.prisma.bundle.update({
      where: { id: bundleId },
      data: { sourceMediaId: mediaId, isUnpackedArchive: true },
    });
  }

  async getBundleItemsForExport (bundleId: string, userId: string) {
    const bundle = await this.prisma.bundle.findFirst({
      where: { id: bundleId, userId },
      select: {
        name: true,
        items: {
          orderBy: { order: "asc" },
          select: {
            media: {
              select: {
                id: true,
                storageKey: true,
                title: true,
                mimeType: true,
                filename: true,
              },
            },
          },
        },
      },
    });

    if (!bundle) return null;

    return {
      name: bundle.name,
      items: bundle.items.map(i => i.media),
    };
  }

  async createBundle (userId: string, name: string, description?: string, coverMediaId?: string) {
    return this.prisma.bundle.create({
      data: { userId, name, description, coverMediaId },
      select: { id: true, name: true, description: true, createdAt: true, updatedAt: true },
    });
  }

  async updateBundle (id: string, userId: string, data: { name?: string; description?: string | null; starred?: boolean; coverMediaId?: string | null }) {
    const result = await this.prisma.bundle.updateMany({
      where: { id, userId },
      data,
    });
    return result.count > 0;
  }

  async deleteBundle (id: string, userId: string) {
    await this.prisma.bundle.deleteMany({ where: { id, userId } });
  }

  async addItems (bundleId: string, userId: string, mediaIds: string[]) {
    // Verify bundle belongs to user
    const bundle = await this.prisma.bundle.findFirst({
      where: { id: bundleId, userId },
      select: { id: true },
    });
    if (!bundle) return false;

    // Verify all media belongs to user
    const mediaCount = await this.prisma.media.count({
      where: { id: { in: mediaIds }, userId },
    });
    if (mediaCount !== mediaIds.length) return false;

    // Get current max order
    const maxItem = await this.prisma.bundleItem.findFirst({
      where: { bundleId },
      orderBy: { order: "desc" },
      select: { order: true },
    });
    const startOrder = (maxItem?.order ?? -1) + 1;

    await this.prisma.bundleItem.createMany({
      data: mediaIds.map((mediaId, i) => ({
        bundleId,
        mediaId,
        order: startOrder + i,
      })),
      skipDuplicates: true,
    });

    // Touch updatedAt on bundle
    await this.prisma.bundle.update({
      where: { id: bundleId },
      data: { updatedAt: new Date() },
    });

    return true;
  }

  /**
   * Reset coverMediaId to null on bundles where it matches `mediaId`.
   * Pass `bundleId` to scope the reset to a single bundle (e.g. when removing
   * an item from a bundle). Omit it to clear across all bundles (e.g. when the
   * media item itself is deleted).
   */
  async clearCoverMedia (mediaId: string, bundleId?: string) {
    await this.prisma.bundle.updateMany({
      where: { coverMediaId: mediaId, ...(bundleId !== undefined ? { id: bundleId } : {}) },
      data: { coverMediaId: null },
    });
  }

  async removeItem (bundleId: string, userId: string, mediaId: string) {
    const bundle = await this.prisma.bundle.findFirst({
      where: { id: bundleId, userId },
      select: { id: true },
    });
    if (!bundle) return false;

    await this.prisma.bundleItem.deleteMany({ where: { bundleId, mediaId } });
    await this.clearCoverMedia(mediaId, bundleId);
    await this.prisma.bundle.update({ where: { id: bundleId }, data: { updatedAt: new Date() } });

    return true;
  }

  async reorderItems (bundleId: string, userId: string, orderedMediaIds: string[]) {
    const bundle = await this.prisma.bundle.findFirst({
      where: { id: bundleId, userId },
      select: { id: true },
    });
    if (!bundle) return false;

    await this.prisma.$transaction(
      orderedMediaIds.map((mediaId, i) =>
        this.prisma.bundleItem.updateMany({
          where: { bundleId, mediaId },
          data: { order: i },
        }),
      ),
    );

    return true;
  }

  async toggleStar (id: string, userId: string): Promise<boolean | null> {
    const bundle = await this.prisma.bundle.findFirst({
      where: { id, userId },
      select: { starred: true },
    });
    if (!bundle) return null;

    const next = !bundle.starred;
    await this.prisma.bundle.update({
      where: { id },
      data: { starred: next, starredAt: next ? new Date() : null },
    });
    return next;
  }
}
