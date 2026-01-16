import { Prisma, type PrismaClient } from "@prisma/client";

export type MediaListFilters = {
  userId: string;
  queryText?: string | null;
  tag?: string | null;
  thumbState?: "PENDING" | "READY" | "ERROR" | "FAILED";
  textState?: "PENDING" | "READY" | "ERROR" | "FAILED";
  orderBy: Prisma.MediaOrderByWithRelationInput[];
  take: number;
  cursor?: string | null;
  skip?: number;
};

export class MediaRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async createMedia (data: Prisma.MediaUncheckedCreateInput) {
    return this.prisma.media.create({
      data,
      select: { id: true, storageKey: true, title: true },
    });
  }

  async createBatch (items: Prisma.MediaCreateManyInput[]) {
    await this.prisma.$transaction(async tx => {
      await tx.media.createMany({ data: items });
    });
  }

  async markSourcesReady (userId: string, ids: string[]) {
    return this.prisma.$queryRaw<{ id: string; storageKey: string }[]>`
      UPDATE "Media"
      SET "sourceState" = 'READY'
      WHERE "userId" = ${userId} AND "id" IN (${Prisma.join(ids)})
      RETURNING "id", "storageKey"
    `;
  }

  async listMedia (filters: MediaListFilters) {
    const { userId, queryText, tag, thumbState, textState, orderBy, take, cursor, skip } = filters;

    return this.prisma.media.findMany({
      where: {
        userId,
        ...(queryText
          ? {
              OR: [
                { title: { contains: queryText, mode: "insensitive" } },
                { document: { is: { rawText: { contains: queryText, mode: "insensitive" } } } },
              ],
            }
          : {}),
        ...(tag ? { tags: { has: tag } } : {}),
        ...(thumbState ? { thumbState } : {}),
        ...(textState ? { textState } : {}),
      },
      orderBy,
      take,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : skip ? { skip } : {}),
      select: {
        id: true,
        title: true,
        thumbState: true,
        textState: true,
        createdAt: true,
        tags: true,
        mimeType: true,
      },
    });
  }

  async findMediaKeys (userId: string, id: string) {
    return this.prisma.media.findFirst({
      where: { id, userId },
      select: { storageKey: true, thumbnailKey: true },
    });
  }

  async deleteMedia (id: string) {
    await this.prisma.media.delete({ where: { id } });
  }

  async findMediaForTitleUpdate (userId: string, id: string) {
    return this.prisma.media.findFirst({
      where: { id, userId },
      select: { id: true },
    });
  }

  async updateTitle (id: string, title: string) {
    return this.prisma.media.update({
      where: { id },
      data: { title },
      select: {
        id: true,
        title: true,
        filename: true,
        sizeBytes: true,
        mimeType: true,
        thumbState: true,
        textState: true,
      },
    });
  }

  async findStorageKey (userId: string, id: string) {
    return this.prisma.media.findFirst({
      where: { id, userId },
      select: { storageKey: true },
    });
  }

  async findDocumentForUser (userId: string, id: string) {
    return this.prisma.media.findFirst({
      where: { id, userId },
      select: {
        mimeType: true,
        document: { select: { rawText: true, textSource: true } },
      },
    });
  }

  async findForTextJob (userId: string, id: string) {
    return this.prisma.media.findFirst({
      where: { id, userId },
      select: { id: true, storageKey: true, title: true },
    });
  }

  async setTextStatePending (id: string) {
    await this.prisma.media.update({
      where: { id },
      data: { textState: "PENDING" },
    });
  }

  async findDetail (userId: string, id: string) {
    return this.prisma.media.findFirst({
      where: { id, userId },
      select: {
        id: true,
        userId: true,
        title: true,
        filename: true,
        mimeType: true,
        sizeBytes: true,
        storageKey: true,
        createdAt: true,
        updatedAt: true,
        tags: true,
        thumbState: true,
        thumbError: true,
        textState: true,
        thumbnailKey: true,
        document: {
          select: {
            rawText: true,
            textSource: true,
          },
        },
      },
    });
  }

  async findThumbInfo (id: string) {
    return this.prisma.media.findUnique({
      where: { id },
      select: { thumbnailKey: true, thumbState: true, mimeType: true },
    });
  }

  async setThumbReady (mediaId: string, thumbnailKey: string) {
    await this.prisma.media.update({
      where: { id: mediaId },
      data: { thumbnailKey, thumbState: "READY", thumbError: null },
    });
  }

  async setThumbFailed (mediaId: string, error: string) {
    await this.prisma.media.update({
      where: { id: mediaId },
      data: { thumbState: "FAILED", thumbError: error },
    });
  }

  async findForOcr (mediaId: string) {
    return this.prisma.media.findUnique({
      where: { id: mediaId },
      select: { id: true, storageKey: true, mimeType: true },
    });
  }

  async setTextState (mediaId: string, state: "PENDING" | "READY" | "ERROR") {
    await this.prisma.media.update({
      where: { id: mediaId },
      data: { textState: state },
    });
  }
}
