// File: MediaRepository.ts
import { Prisma, type PrismaClient } from "@prisma/client";

export type MediaListFilters = {
  userId: string;
  queryText?: string | null;
  tags?: string[];
  thumbState?: "PENDING" | "READY" | "ERROR" | "FAILED";
  textState?: "PENDING" | "READY" | "ERROR" | "FAILED";
  orderBy: Prisma.MediaOrderByWithRelationInput[];
  take: number;
  cursor?: string | null;
  skip?: number;
};

export class MediaRepository {
  constructor (private readonly prisma: PrismaClient) {}

  async createMedia (data: Prisma.MediaUncheckedCreateInput) {
    return this.prisma.media.create({
      data,
      select: { id: true, storageKey: true, title: true },
    });
  }

  async createBatch (items: Prisma.MediaCreateManyInput[]) {
    await this.prisma.media.createMany({ data: items });
  }

  async markSourcesReady (userId: string, ids: string[]) {
    // Raw SQL is required here: Prisma's updateMany does not support RETURNING,
    // and the returned rows (id + storageKey) are used by finalizeBatch to enqueue
    // OCR and thumbnail jobs. Switching to updateMany would silently drop those
    // values and break job enqueueing without a type error.
    return this.prisma.$queryRaw<{ id: string; storageKey: string }[]>`
      UPDATE "Media"
      SET "sourceState" = 'READY'
      WHERE "userId" = ${userId} AND "id" IN (${Prisma.join(ids)})
      RETURNING "id", "storageKey"
    `;
  }

  async listMedia (filters: MediaListFilters) {
    const { userId, queryText, tags, thumbState, textState, orderBy, take, cursor } = filters;

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
        ...(tags?.length ? { tags: { hasEvery: tags } } : {}),
        ...(thumbState ? { thumbState } : {}),
        ...(textState ? { textState } : {}),
      },
      orderBy,
      take,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
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
    return this.findMediaForUpdate(userId, id);
  }

  async findMediaForUpdate (userId: string, id: string) {
    return this.prisma.media.findFirst({
      where: { id, userId },
      select: { id: true },
    });
  }

  async updateMetadata (id: string, data: { title?: string; tags?: string[] }) {
    const update = {
      ...(data.title !== undefined ? { title: data.title } : {}),
      ...(data.tags !== undefined ? { tags: data.tags } : {}),
    };
    const select = {
      id: true,
      title: true,
      filename: true,
      sizeBytes: true,
      mimeType: true,
      thumbState: true,
      textState: true,
      tags: true,
    };

    return this.prisma.media.update({ where: { id }, data: update, select });
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

  async setTextStatePending (id: string): Promise<boolean> {
    // Re-run trigger: allowed from READY or ERROR (and idempotently from PENDING).
    // NOT allowed if somehow the record ends up in an unknown state — but all three
    // normal states are listed here, so that case doesn't arise in practice.
    const result = await this.prisma.media.updateMany({
      where: { id, textState: { in: ["PENDING", "READY", "ERROR"] } },
      data: { textState: "PENDING" },
    });
    return result.count > 0;
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
            pages: true,
          },
        },
        extractedMetadata: {
          select: { data: true },
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

  async setThumbReady (mediaId: string, thumbnailKey: string): Promise<boolean> {
    // Guard: only transition from PENDING. Prevents a late-arriving worker from
    // overwriting a FAILED state with READY (e.g., retry completing after exhaustion).
    const result = await this.prisma.media.updateMany({
      where: { id: mediaId, thumbState: "PENDING" },
      data: { thumbnailKey, thumbState: "READY", thumbError: null },
    });
    return result.count > 0;
  }

  async resetThumbState (mediaId: string): Promise<boolean> {
    const result = await this.prisma.media.updateMany({
      where: { id: mediaId },
      data: { thumbnailKey: null, thumbState: "PENDING", thumbError: null },
    });
    return result.count > 0;
  }

  async setThumbFailed (mediaId: string, error: string): Promise<boolean> {
    // Guard: only transition from PENDING. Prevents retrograde READY → FAILED writes.
    const result = await this.prisma.media.updateMany({
      where: { id: mediaId, thumbState: "PENDING" },
      data: { thumbState: "FAILED", thumbError: error },
    });
    return result.count > 0;
  }

  async findForOcr (mediaId: string) {
    return this.prisma.media.findUnique({
      where: { id: mediaId },
      select: { id: true, storageKey: true, mimeType: true, textState: true, sizeBytes: true },
    });
  }

  async getTextState (mediaId: string) {
    const media = await this.prisma.media.findUnique({
      where: { id: mediaId },
      select: { textState: true },
    });
    return media?.textState ?? null;
  }

  async setTextState (mediaId: string, state: "PENDING" | "READY" | "ERROR"): Promise<boolean> {
    // Guard: worker-initiated writes (including PDF intermediate PENDING→PENDING re-queues)
    // are only allowed from PENDING. This prevents a late worker from overwriting a cancel
    // or stall-detection ERROR with READY.
    const result = await this.prisma.media.updateMany({
      where: { id: mediaId, textState: "PENDING" },
      data: { textState: state },
    });
    return result.count > 0;
  }

  // ---------------------------------------------------------------------------
  // Stall detection helpers
  // ---------------------------------------------------------------------------

  /** Returns media whose thumbState or textState has been stuck at PENDING since before staleBefore. */
  async findStalledMedia (staleBefore: Date) {
    return this.prisma.media.findMany({
      where: {
        OR: [
          { thumbState: "PENDING", updatedAt: { lt: staleBefore } },
          { textState: "PENDING", updatedAt: { lt: staleBefore } },
        ],
      },
      select: { id: true, thumbState: true, textState: true },
    });
  }

  /** Marks thumbState PENDING → FAILED for a batch of media ids. Returns the number updated. */
  async markThumbStalled (mediaIds: string[], error: string): Promise<number> {
    const result = await this.prisma.media.updateMany({
      where: { id: { in: mediaIds }, thumbState: "PENDING" },
      data: { thumbState: "FAILED", thumbError: error },
    });
    return result.count;
  }

  /** Marks textState PENDING → ERROR for a batch of media ids. Returns the number updated. */
  async markTextStalled (mediaIds: string[]): Promise<number> {
    const result = await this.prisma.media.updateMany({
      where: { id: { in: mediaIds }, textState: "PENDING" },
      data: { textState: "ERROR" },
    });
    return result.count;
  }

  async listTopTags (userId: string, limit: number) {
    return this.prisma.$queryRaw<{ tag: string; count: number }[]>`
      SELECT tag, COUNT(*)::int AS count
      FROM (
        SELECT unnest("tags") AS tag
        FROM "Media"
        WHERE "userId" = ${userId}
      ) t
      GROUP BY tag
      ORDER BY count DESC, tag ASC
      LIMIT ${limit}
    `;
  }

  async deleteTag (userId: string, tag: string) {
    await this.prisma.$executeRaw`
      UPDATE "Media"
      SET "tags" = array_remove("tags", ${tag})
      WHERE "userId" = ${userId} AND ${tag} = ANY("tags")
    `;
  }
}
