import { type PrismaClient } from "@prisma/client";

export class BundleRepository {
  constructor (private readonly prisma: PrismaClient) {}

  async listBundles (userId: string) {
    const bundles = await this.prisma.bundle.findMany({
      where: { userId },
      orderBy: [{ starred: "desc" }, { updatedAt: "desc" }],
      select: {
        id: true,
        name: true,
        description: true,
        starred: true,
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
                thumbState: true,
                thumbnailKey: true,
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
      createdAt: bundle.createdAt.toISOString(),
      updatedAt: bundle.updatedAt.toISOString(),
      items: bundle.items.map(item => ({
        mediaId: item.mediaId,
        order: item.order,
        addedAt: item.addedAt.toISOString(),
        title: item.media.title,
        mimeType: item.media.mimeType,
        thumbState: item.media.thumbState,
        thumbnailKey: item.media.thumbnailKey,
      })),
    };
  }

  async createBundle (userId: string, name: string, description?: string) {
    return this.prisma.bundle.create({
      data: { userId, name, description },
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

  async removeItem (bundleId: string, userId: string, mediaId: string) {
    const bundle = await this.prisma.bundle.findFirst({
      where: { id: bundleId, userId },
      select: { id: true },
    });
    if (!bundle) return false;

    await this.prisma.bundleItem.deleteMany({ where: { bundleId, mediaId } });

    await this.prisma.bundle.update({
      where: { id: bundleId },
      data: { updatedAt: new Date() },
    });

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
      data: { starred: next },
    });
    return next;
  }
}
