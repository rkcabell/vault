/**
 * Reads and writes bundles, the named collections a user groups media items
 * into. Unpacking an archive also produces one.
 */
import { type PrismaClient } from "@prisma/client";

/**
 * Stores one user's bundles and the items in them.
 *
 * Every method is filtered by the owning user, and the ones that change
 * something return false or null instead of raising when the user owns no such
 * bundle.
 *
 * A bundle with no cover picked out is presented using its first item.
 */
export class BundleRepository {
  constructor (private readonly prisma: PrismaClient) {}

  /**
   * Returns the user's bundles, starred ones first and then most recently
   * changed.
   *
   * `q` matches a bundle's own name and description, and also the titles and
   * extracted text of the items inside it, so a bundle is found by what it
   * holds.
   */
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

  /** Returns one bundle with every item in it, in the order the user arranged them, or null if the user does not own it. */
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

  /** Records which archive a bundle was unpacked from, and marks it as one. The caller must have checked ownership. */
  async setSourceMedia (bundleId: string, mediaId: string) {
    await this.prisma.bundle.update({
      where: { id: bundleId },
      data: { sourceMediaId: mediaId, isUnpackedArchive: true },
    });
  }

  /** Returns what a download of the bundle needs: its name, and each item's file in bundle order. */
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

  /** Creates an empty bundle and returns it. */
  async createBundle (userId: string, name: string, description?: string, coverMediaId?: string) {
    return this.prisma.bundle.create({
      data: { userId, name, description, coverMediaId },
      select: { id: true, name: true, description: true, createdAt: true, updatedAt: true },
    });
  }

  /** True if the bundle was changed. False means the user owns no bundle with that id. */
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

  /**
   * Deletes a bundle and reports which of its items should go with it.
   *
   * A bundle unpacked from an archive owns its items, so their ids come back
   * for the caller to delete as well. Items in an ordinary bundle exist on
   * their own and are never returned.
   */
  async deleteBundleWithCascade (id: string, userId: string): Promise<{ found: boolean; extractedMediaIds: string[] }> {
    const bundle = await this.prisma.bundle.findFirst({
      where: { id, userId },
      select: {
        isUnpackedArchive: true,
        sourceMediaId: true,
        items: { select: { mediaId: true } },
      },
    });

    if (!bundle) return { found: false, extractedMediaIds: [] };

    await this.prisma.bundle.deleteMany({ where: { id, userId } });

    if (bundle.sourceMediaId) {
      await this.prisma.media.updateMany({
        where: { id: bundle.sourceMediaId },
        data: { linkedBundleId: null },
      });
    }

    const extractedMediaIds = bundle.isUnpackedArchive
      ? bundle.items.map(i => i.mediaId)
      : [];

    return { found: true, extractedMediaIds };
  }

  /**
   * Adds items to the end of a bundle, keeping the order they arrive in.
   *
   * Returns false unless the user owns the bundle and every item named. An item
   * already in the bundle is passed over rather than added twice.
   */
  async addItems (bundleId: string, userId: string, mediaIds: string[]) {
    const bundle = await this.prisma.bundle.findFirst({
      where: { id: bundleId, userId },
      select: { id: true },
    });
    if (!bundle) return false;

    const mediaCount = await this.prisma.media.count({
      where: { id: { in: mediaIds }, userId },
    });
    if (mediaCount !== mediaIds.length) return false;

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

    await this.prisma.bundle.update({
      where: { id: bundleId },
      data: { updatedAt: new Date() },
    });

    return true;
  }

  /**
   * Clears the chosen cover from bundles that were using `mediaId` for it.
   *
   * Pass `bundleId` when the item is only leaving that one bundle. Omit it when
   * the item is being deleted, so no bundle is left pointing at it.
   */
  async clearCoverMedia (mediaId: string, bundleId?: string) {
    await this.prisma.bundle.updateMany({
      where: { coverMediaId: mediaId, ...(bundleId !== undefined ? { id: bundleId } : {}) },
      data: { coverMediaId: null },
    });
  }

  /** Clears the chosen cover from any of the user's bundles using one of `mediaIds`. */
  async clearCoverMediaForIds (userId: string, mediaIds: string[]) {
    if (mediaIds.length === 0) return;
    await this.prisma.bundle.updateMany({
      where: { userId, coverMediaId: { in: mediaIds } },
      data: { coverMediaId: null },
    });
  }

  /** Takes an item out of a bundle, clearing the cover if that item was it. False means the user owns no such bundle. */
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

  /**
   * Rearranges a bundle's items to match the order of `orderedMediaIds`.
   *
   * Pass every item in the bundle. An item left out keeps its old position and
   * can then share a position with another item.
   */
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

  /** Stars an unstarred bundle or unstars a starred one, returning the new state. Null means the user owns no such bundle. */
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
