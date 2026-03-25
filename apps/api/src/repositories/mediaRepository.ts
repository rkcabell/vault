// File: MediaRepository.ts
import { Prisma, type PrismaClient } from "@prisma/client";

export type MediaListFilters = {
  userId: string;
  queryText?: string | null;
  tags?: string[];
  excludeTags?: string[];
  thumbState?: "PENDING" | "READY" | "ERROR" | "FAILED";
  textState?: "PENDING" | "READY" | "ERROR" | "FAILED";
  mimeTypePrefix?: string;
  orderBy: Prisma.MediaOrderByWithRelationInput[];
  take: number;
  cursor?: string | null;
  excludeUnpacked?: boolean;
};

export class MediaRepository {
  constructor (private readonly prisma: PrismaClient) {}

  /** Insert a new Media row and return its id, storageKey, and title. */
  async createMedia (data: Prisma.MediaUncheckedCreateInput) {
    const media = await this.prisma.media.create({
      data,
      select: { id: true, storageKey: true, title: true },
    });

    // Sync Tag counts for initial tags.
    const tags = (data.tags as string[] | undefined) ?? [];
    await this.upsertTags(data.userId as string, tags);

    return media;
  }

  /** Bulk-insert Media rows without returning individual ids (used in batch upload init). */
  async createBatch (items: Prisma.MediaCreateManyInput[]) {
    await this.prisma.media.createMany({ data: items });

    // Sync Tag counts: aggregate tags per userId across all items.
    const tagsByUser = new Map<string, string[]>();
    for (const item of items) {
      const uid = item.userId as string;
      const tags = (item.tags as string[] | undefined) ?? [];
      if (!tagsByUser.has(uid)) tagsByUser.set(uid, []);
      tagsByUser.get(uid)!.push(...tags);
    }
    for (const [uid, tags] of tagsByUser) {
      await this.upsertTags(uid, tags);
    }
  }

  async markSourcesReady (userId: string, ids: string[]) {
    // Raw SQL is required here: Prisma's updateMany does not support RETURNING,
    // and the returned rows (id + storageKey) are used by finalizeBatch to enqueue
    // OCR and thumbnail jobs. Switching to updateMany would silently drop those
    // values and break job enqueueing without a type error.
    return this.prisma.$queryRaw<{ id: string; storageKey: string; mimeType: string }[]>`
      UPDATE "Media"
      SET "sourceState" = 'READY'
      WHERE "userId" = ${userId} AND "id" IN (${Prisma.join(ids)})
      RETURNING "id", "storageKey", "mimeType"
    `;
  }

  /**
   * Paginated media listing. When no tag filter is present the ORM path is
   * used (cursor + skip:1). When tags are present a single raw SQL query is
   * used so the case-insensitive array-containment check is inlined and no
   * unbounded IN list is materialised. Keyset pagination is used in that path.
   */
  async listMedia (filters: MediaListFilters) {
    if (filters.tags?.length || filters.excludeTags?.length) return this._listMediaRaw(filters);
    return this._listMediaOrm(filters);
  }

  /** Count media matching the same filters as listMedia, ignoring pagination (take/cursor). */
  async countMedia (filters: MediaListFilters): Promise<number> {
    if (filters.tags?.length || filters.excludeTags?.length) return this._countMediaRaw(filters);
    return this._countMediaOrm(filters);
  }

  private async _listMediaOrm (filters: MediaListFilters) {
    const { userId, queryText, excludeTags, thumbState, textState, mimeTypePrefix, orderBy, take, cursor, excludeUnpacked } = filters;
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
        ...(excludeTags?.length
          ? { AND: excludeTags.map(t => ({ NOT: { tags: { has: t } } })) }
          : {}),
        ...(thumbState ? { thumbState } : {}),
        ...(textState ? { textState } : {}),
        ...(mimeTypePrefix ? { mimeType: { startsWith: mimeTypePrefix } } : {}),
        ...(excludeUnpacked ? { isExtractedFromArchive: false } : {}),
      },
      orderBy,
      take,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true, title: true, filename: true,
        thumbState: true, textState: true, createdAt: true,
        tags: true, mimeType: true, sizeBytes: true,
      },
    });
  }

  private async _listMediaRaw (filters: MediaListFilters) {
    const { userId, queryText, tags, excludeTags, thumbState, textState, mimeTypePrefix, orderBy, take, cursor, excludeUnpacked } = filters;

    // Derive sort column and direction from the Prisma orderBy structure.
    // buildOrderBy always puts the primary column first; the tiebreaker id second.
    const [[sortField, sortDir]] = Object.entries(orderBy[0]) as [[string, "asc" | "desc"]];

    // Map camelCase field names to quoted Postgres column identifiers.
    // These come from a closed enum in buildOrderBy — never from user input.
    const COL: Record<string, string> = {
      createdAt: '"createdAt"',
      title: "title",
      sizeBytes: '"sizeBytes"',
      mimeType: '"mimeType"',
    };
    const col = COL[sortField] ?? '"createdAt"';
    const dir = sortDir === "asc" ? "ASC" : "DESC";
    const cmp = sortDir === "asc" ? ">" : "<";

    // Keyset cursor: look up the cursor row's sort-column value by PK (fast).
    let cursorSortVal: unknown = null;
    let cursorId: string | null = null;
    if (cursor) {
      const row = await this.prisma.media.findFirst({
        where: { id: cursor },
        select: { id: true, [sortField]: true },
      }) as Record<string, unknown> | null;
      if (!row) return [];
      cursorSortVal = row[sortField];
      cursorId = row.id as string;
    }

    // Build WHERE conditions; all user-supplied values are bound as $n params.
    const conditions: string[] = [`m."userId" = $1`];
    const params: unknown[] = [userId];
    let p = 2;

    // Tag include condition: all specified tags must be present (case-insensitive).
    if (tags?.length) {
      const tagPlaceholders = tags.map(() => `$${p++}`).join(", ");
      conditions.push(`ARRAY(SELECT lower(t) FROM unnest(m.tags) AS t) @> ARRAY[${tagPlaceholders}]::text[]`);
      params.push(...tags.map(t => t.toLowerCase()));
    }

    // Tag exclude conditions: item must not have any of these tags.
    if (excludeTags?.length) {
      for (const t of excludeTags) {
        conditions.push(`NOT ($${p++} = ANY(ARRAY(SELECT lower(x) FROM unnest(m.tags) AS x)))`);
        params.push(t.toLowerCase());
      }
    }

    if (queryText) {
      // $p is used twice in the OR — Postgres reuses the same bound value.
      conditions.push(`(m.title ILIKE $${p} OR EXISTS (SELECT 1 FROM "Document" d WHERE d."mediaId" = m.id AND d."rawText" ILIKE $${p}))`);
      params.push(`%${queryText}%`);
      p++;
    }
    if (thumbState)     { conditions.push(`m."thumbState" = $${p++}`); params.push(thumbState); }
    if (textState)      { conditions.push(`m."textState" = $${p++}`);  params.push(textState);  }
    if (mimeTypePrefix) { conditions.push(`m."mimeType" LIKE $${p++}`); params.push(`${mimeTypePrefix}%`); }
    if (excludeUnpacked) conditions.push(`m."isExtractedFromArchive" = false`);

    if (cursorId !== null) {
      // Keyset: (col, id) cmp (cursorColVal, cursorId). $p is reused for col equality.
      conditions.push(`(m.${col} ${cmp} $${p} OR (m.${col} = $${p} AND m.id ${cmp} $${p + 1}))`);
      params.push(cursorSortVal, cursorId);
      p += 2;
    }

    params.push(take);

    const sql = `
      SELECT m.id, m.title, m.filename, m."thumbState", m."textState", m."createdAt", m.tags, m."mimeType", m."sizeBytes"
      FROM "Media" m
      WHERE ${conditions.join(" AND ")}
      ORDER BY m.${col} ${dir}, m.id ${dir}
      LIMIT $${p}
    `;

    return this.prisma.$queryRawUnsafe<Array<{
      id: string; title: string; filename: string;
      thumbState: string; textState: string;
      createdAt: Date; tags: string[]; mimeType: string; sizeBytes: number;
    }>>(sql, ...params);
  }

  private async _countMediaOrm (filters: MediaListFilters): Promise<number> {
    const { userId, queryText, excludeTags, thumbState, textState, mimeTypePrefix, excludeUnpacked } = filters;
    return this.prisma.media.count({
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
        ...(excludeTags?.length
          ? { AND: excludeTags.map(t => ({ NOT: { tags: { has: t } } })) }
          : {}),
        ...(thumbState ? { thumbState } : {}),
        ...(textState ? { textState } : {}),
        ...(mimeTypePrefix ? { mimeType: { startsWith: mimeTypePrefix } } : {}),
        ...(excludeUnpacked ? { isExtractedFromArchive: false } : {}),
      },
    });
  }

  private async _countMediaRaw (filters: MediaListFilters): Promise<number> {
    const { userId, queryText, tags, excludeTags, thumbState, textState, mimeTypePrefix, excludeUnpacked } = filters;
    const conditions: string[] = [`m."userId" = $1`];
    const params: unknown[] = [userId];
    let p = 2;

    if (tags?.length) {
      const tagPlaceholders = tags.map(() => `$${p++}`).join(", ");
      conditions.push(`ARRAY(SELECT lower(t) FROM unnest(m.tags) AS t) @> ARRAY[${tagPlaceholders}]::text[]`);
      params.push(...tags.map(t => t.toLowerCase()));
    }

    if (excludeTags?.length) {
      for (const t of excludeTags) {
        conditions.push(`NOT ($${p++} = ANY(ARRAY(SELECT lower(x) FROM unnest(m.tags) AS x)))`);
        params.push(t.toLowerCase());
      }
    }

    if (queryText) {
      conditions.push(`(m.title ILIKE $${p} OR EXISTS (SELECT 1 FROM "Document" d WHERE d."mediaId" = m.id AND d."rawText" ILIKE $${p}))`);
      params.push(`%${queryText}%`);
      p++;
    }
    if (thumbState)     { conditions.push(`m."thumbState" = $${p++}`); params.push(thumbState); }
    if (textState)      { conditions.push(`m."textState" = $${p++}`);  params.push(textState);  }
    if (mimeTypePrefix) { conditions.push(`m."mimeType" LIKE $${p++}`); params.push(`${mimeTypePrefix}%`); }
    if (excludeUnpacked) conditions.push(`m."isExtractedFromArchive" = false`);

    const sql = `SELECT COUNT(*)::int AS count FROM "Media" m WHERE ${conditions.join(" AND ")}`;
    const result = await this.prisma.$queryRawUnsafe<[{ count: number }]>(sql, ...params);
    return result[0]?.count ?? 0;
  }

  /** Return all media IDs matching the given filters — no pagination, used for bulk operations. */
  async listAllMediaIds (filters: Omit<MediaListFilters, "orderBy" | "take" | "cursor">): Promise<string[]> {
    const { tags, excludeTags } = filters;
    if (tags?.length || excludeTags?.length) return this._listAllMediaIdsRaw(filters);
    return this._listAllMediaIdsOrm(filters);
  }

  private async _listAllMediaIdsOrm (filters: Omit<MediaListFilters, "orderBy" | "take" | "cursor">): Promise<string[]> {
    const { userId, queryText, excludeTags, thumbState, textState, mimeTypePrefix, excludeUnpacked } = filters;
    const rows = await this.prisma.media.findMany({
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
        ...(excludeTags?.length
          ? { AND: excludeTags.map(t => ({ NOT: { tags: { has: t } } })) }
          : {}),
        ...(thumbState ? { thumbState } : {}),
        ...(textState ? { textState } : {}),
        ...(mimeTypePrefix ? { mimeType: { startsWith: mimeTypePrefix } } : {}),
        ...(excludeUnpacked ? { isExtractedFromArchive: false } : {}),
      },
      select: { id: true },
    });
    return rows.map(r => r.id);
  }

  private async _listAllMediaIdsRaw (filters: Omit<MediaListFilters, "orderBy" | "take" | "cursor">): Promise<string[]> {
    const { userId, queryText, tags, excludeTags, thumbState, textState, mimeTypePrefix, excludeUnpacked } = filters;
    const conditions: string[] = [`m."userId" = $1`];
    const params: unknown[] = [userId];
    let p = 2;

    if (tags?.length) {
      const tagPlaceholders = tags.map(() => `$${p++}`).join(", ");
      conditions.push(`ARRAY(SELECT lower(t) FROM unnest(m.tags) AS t) @> ARRAY[${tagPlaceholders}]::text[]`);
      params.push(...tags.map(t => t.toLowerCase()));
    }
    if (excludeTags?.length) {
      for (const t of excludeTags) {
        conditions.push(`NOT ($${p++} = ANY(ARRAY(SELECT lower(x) FROM unnest(m.tags) AS x)))`);
        params.push(t.toLowerCase());
      }
    }
    if (queryText) {
      conditions.push(`(m.title ILIKE $${p} OR EXISTS (SELECT 1 FROM "Document" d WHERE d."mediaId" = m.id AND d."rawText" ILIKE $${p}))`);
      params.push(`%${queryText}%`);
      p++;
    }
    if (thumbState)     { conditions.push(`m."thumbState" = $${p++}`); params.push(thumbState); }
    if (textState)      { conditions.push(`m."textState" = $${p++}`);  params.push(textState);  }
    if (mimeTypePrefix) { conditions.push(`m."mimeType" LIKE $${p++}`); params.push(`${mimeTypePrefix}%`); }
    if (excludeUnpacked) conditions.push(`m."isExtractedFromArchive" = false`);

    const sql = `SELECT m.id FROM "Media" m WHERE ${conditions.join(" AND ")}`;
    const result = await this.prisma.$queryRawUnsafe<{ id: string }[]>(sql, ...params);
    return result.map(r => r.id);
  }

  /** Return storageKey and thumbnailKey for a media item (used to delete S3 objects). */
  async findMediaKeys (userId: string, id: string) {
    return this.prisma.media.findFirst({
      where: { id, userId },
      select: { storageKey: true, thumbnailKey: true },
    });
  }

  async deleteMedia (id: string) {
    await this.prisma.$transaction(async tx => {
      const media = await tx.media.findUnique({
        where: { id },
        select: { userId: true, tags: true },
      });
      if (!media) return;

      await tx.media.delete({ where: { id } });

      const tagNames = [...new Set(media.tags ?? [])];
      if (tagNames.length > 0) {
        // Single query to count remaining media per tag instead of N queries
        const rows = await tx.$queryRaw<Array<{ name: string; count: number }>>`
          SELECT tag_name AS name, COUNT(m.id)::int AS count
          FROM unnest(${tagNames}::text[]) AS tag_name
          LEFT JOIN "Media" m ON m."userId" = ${media.userId} AND tag_name = ANY(m.tags)
          GROUP BY tag_name
        `;
        const toDelete = rows.filter(r => r.count === 0).map(r => r.name);
        if (toDelete.length > 0) {
          await tx.tag.deleteMany({ where: { userId: media.userId, name: { in: toDelete } } });
        }
        for (const { name, count } of rows.filter(r => r.count > 0)) {
          await tx.tag.updateMany({ where: { userId: media.userId, name }, data: { count } });
        }
      }
    });
  }

  /** Bulk-delete all media for a user in 4 queries. Returns S3 keys for deletion.
   *  DB-level cascades handle BundleItem, Document, MediaExtractedMetadata, and
   *  the SetNull relations (Reminder.mediaId, Bundle.sourceMediaId). The only
   *  non-FK field, Bundle.coverMediaId, is cleared manually. */
  async deleteAllMediaForUser (userId: string): Promise<Array<{ storageKey: string; thumbnailKey: string | null }>> {
    const items = await this.prisma.media.findMany({
      where: { userId },
      select: { storageKey: true, thumbnailKey: true },
    });
    if (items.length === 0) return [];
    await this.prisma.media.deleteMany({ where: { userId } });
    await this.prisma.tag.deleteMany({ where: { userId } });
    await this.prisma.bundle.updateMany({ where: { userId }, data: { coverMediaId: null } });
    return items;
  }

  /** Recompute Tag.count from actual Media rows and delete any tags with no remaining media.
   *  Call this after any bulk delete to fix counts that went stale due to concurrent transactions. */
  async reconcileTagCounts (userId: string): Promise<void> {
    const rows = await this.prisma.$queryRaw<Array<{ name: string; count: bigint }>>`
      SELECT t.name, COUNT(m.id) AS count
      FROM "Tag" t
      LEFT JOIN "Media" m ON m."userId" = t."userId" AND t.name = ANY(m.tags)
      WHERE t."userId" = ${userId}
      GROUP BY t.name
    `;
    const toDelete: string[] = [];
    const toUpdate: { name: string; count: number }[] = [];
    for (const row of rows) {
      const n = Number(row.count);
      if (n === 0) toDelete.push(row.name);
      else toUpdate.push({ name: row.name, count: n });
    }
    if (toDelete.length > 0) {
      await this.prisma.tag.deleteMany({ where: { userId, name: { in: toDelete } } });
    }
    for (const { name, count } of toUpdate) {
      await this.prisma.tag.updateMany({ where: { userId, name }, data: { count } });
    }
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

  async updateMetadata (id: string, data: { title?: string; tags?: string[] }, userId?: string) {
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

    // When tags are changing and we have a userId, sync Tag counts in a transaction.
    if (data.tags !== undefined && userId !== undefined) {
      return this.prisma.$transaction(async tx => {
        const oldMedia = await tx.media.findUnique({ where: { id }, select: { tags: true } });
        const oldTags = oldMedia?.tags ?? [];

        const updated = await tx.media.update({ where: { id }, data: update, select });

        const newSet = new Set(data.tags!);
        const oldSet = new Set(oldTags);
        const added   = data.tags!.filter(t => !oldSet.has(t));
        const removed = oldTags.filter(t => !newSet.has(t));

        for (const name of added) {
          await tx.tag.upsert({
            where: { userId_name: { userId, name } },
            update: { count: { increment: 1 } },
            create: { userId, name, count: 1 },
          });
        }
        for (const name of removed) {
          await tx.$executeRaw`UPDATE "Tag" SET count = count - 1 WHERE "userId" = ${userId} AND name = ${name}`;
          await tx.$executeRaw`DELETE FROM "Tag" WHERE "userId" = ${userId} AND name = ${name} AND count <= 0`;
        }

        return updated;
      });
    }

    return this.prisma.media.update({ where: { id }, data: update, select });
  }

  /** Append `tagName` to the media item's tags if not already present, and keep the Tag
   *  table count in sync. No-ops if the tag is already on the item. */
  async addTagIfAbsent (mediaId: string, tagName: string): Promise<void> {
    await this.prisma.$transaction(async tx => {
      const media = await tx.media.findUnique({
        where: { id: mediaId },
        select: { userId: true, tags: true },
      });
      if (!media) return;
      if (media.tags.includes(tagName)) return;

      const newTags = [...media.tags, tagName];
      await tx.media.update({ where: { id: mediaId }, data: { tags: newTags } });
      await tx.tag.upsert({
        where: { userId_name: { userId: media.userId, name: tagName } },
        update: { count: { increment: 1 } },
        create: { userId: media.userId, name: tagName, count: 1 },
      });
    });
  }

  async findStorageKey (userId: string, id: string) {
    return this.prisma.media.findFirst({
      where: { id, userId },
      select: { storageKey: true },
    });
  }

  async findBulkDownloadItems (userId: string, ids: string[]) {
    return this.prisma.media.findMany({
      where: { id: { in: ids }, userId },
      select: { id: true, storageKey: true, title: true, mimeType: true, filename: true },
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

  /**
   * Transition textState to PENDING for a user-triggered re-run.
   * Allowed from PENDING, READY, or ERROR. Returns false only if the row
   * doesn't exist or is in an unexpected state (shouldn't happen in practice).
   */
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

  async setLinkedBundle (id: string, bundleId: string) {
    await this.prisma.media.update({
      where: { id },
      data: { linkedBundleId: bundleId },
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
        linkedBundleId: true,
        bundleItems: {
          select: {
            bundle: {
              select: { id: true, name: true },
            },
          },
        },
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

  /**
   * Atomically mark the thumbnail as ready and store its key.
   * Guards on thumbState = PENDING so a late-arriving worker can't overwrite
   * a FAILED state (e.g. after retry exhaustion) with READY.
   * Returns false if the guard prevented the update.
   */
  async setThumbReady (mediaId: string, thumbnailKey: string): Promise<boolean> {
    // Guard: only transition from PENDING. Prevents a late-arriving worker from
    // overwriting a FAILED state with READY (e.g., retry completing after exhaustion).
    const result = await this.prisma.media.updateMany({
      where: { id: mediaId, thumbState: "PENDING" },
      data: { thumbnailKey, thumbState: "READY", thumbError: null },
    });
    return result.count > 0;
  }

  /** Clear thumbnailKey and reset thumbState to PENDING (used to re-trigger thumbnail generation). */
  async resetThumbState (mediaId: string): Promise<boolean> {
    const result = await this.prisma.media.updateMany({
      where: { id: mediaId },
      data: { thumbnailKey: null, thumbState: "PENDING", thumbError: null },
    });
    return result.count > 0;
  }

  /**
   * Mark thumbnail generation as permanently failed and store the sanitized error message.
   * Guards on thumbState = PENDING to prevent retrograde READY → FAILED writes.
   */
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

  /** Read the current textState for a media item (used to check for cancellation before processing). */
  async getTextState (mediaId: string) {
    const media = await this.prisma.media.findUnique({
      where: { id: mediaId },
      select: { textState: true },
    });
    return media?.textState ?? null;
  }

  async setTextState (mediaId: string, state: "PENDING" | "READY" | "ERROR" | "FAILED"): Promise<boolean> {
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

  /** Marks textState PENDING → FAILED for items whose MIME type is not supported for text extraction. */
  async markTextUnsupported (mediaIds: string[]): Promise<void> {
    if (mediaIds.length === 0) return;
    await this.prisma.media.updateMany({
      where: { id: { in: mediaIds }, textState: "PENDING" },
      data: { textState: "FAILED" },
    });
  }

  /**
   * Return the most-used tags for a user, ordered by frequency descending then
   * alphabetically. Queries the denormalized Tag table directly — O(limit) instead
   * of a full Media table unnest scan.
   */
  async listTopTags (userId: string, limit: number, offset = 0) {
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.tag.findMany({
        where: { userId },
        orderBy: [{ count: 'desc' }, { name: 'asc' }],
        take: limit,
        skip: offset,
        select: { name: true, count: true, color: true },
      }),
      this.prisma.tag.count({ where: { userId } }),
    ]);
    return {
      tags: rows.map(r => ({ tag: r.name, count: r.count, color: r.color ?? null })),
      total,
    };
  }

  /**
   * Remove a tag from every Media row owned by the user, and delete its Tag row.
   * Returns the number of Media rows updated.
   */
  async deleteTag (userId: string, tag: string): Promise<number> {
    return this.prisma.$transaction(async tx => {
      const affected = await tx.$executeRaw`
        UPDATE "Media"
        SET "tags" = array_remove("tags", ${tag})
        WHERE "userId" = ${userId} AND ${tag} = ANY("tags")
      `;
      await tx.tag.deleteMany({ where: { userId, name: tag } });
      return affected;
    });
  }

  /**
   * Delete Tag rows that are not referenced by any Media.tags entry for the user.
   * Returns the number of Tag rows deleted.
   */
  async deleteOrphanTags (userId: string): Promise<number> {
    return this.prisma.$transaction(async tx => {
      const orphanRows = await tx.$queryRaw<Array<{ name: string }>>`
        SELECT t.name
        FROM "Tag" t
        WHERE t."userId" = ${userId}
          AND NOT EXISTS (
            SELECT 1
            FROM "Media" m
            WHERE m."userId" = t."userId"
              AND t.name = ANY(m.tags)
          )
      `;

      const orphanNames = orphanRows.map(row => row.name);
      if (orphanNames.length === 0) return 0;

      const result = await tx.tag.deleteMany({
        where: { userId, name: { in: orphanNames } },
      });
      return result.count;
    });
  }

  /**
   * Rename a tag across all Media rows and update the Tag row.
   * Returns the number of Media rows updated.
   */
  async renameTag (userId: string, oldName: string, newName: string): Promise<number> {
    return this.prisma.$transaction(async tx => {
      const affected = await tx.$executeRaw`
        UPDATE "Media"
        SET "tags" = array_replace("tags", ${oldName}, ${newName})
        WHERE "userId" = ${userId} AND ${oldName} = ANY("tags")
      `;
      // Rename the Tag row. If newName already exists, merge counts then delete old.
      const existing = await tx.tag.findUnique({ where: { userId_name: { userId, name: newName } } });
      const oldRow   = await tx.tag.findUnique({ where: { userId_name: { userId, name: oldName } } });
      if (existing && oldRow) {
        await tx.tag.update({
          where: { userId_name: { userId, name: newName } },
          data: { count: existing.count + oldRow.count },
        });
        await tx.tag.delete({ where: { userId_name: { userId, name: oldName } } });
      } else if (oldRow) {
        await tx.tag.update({
          where: { userId_name: { userId, name: oldName } },
          data: { name: newName },
        });
      }
      return affected;
    });
  }

  /** Set or clear the color on a tag row. */
  async setTagColor (userId: string, name: string, color: string | null): Promise<void> {
    await this.prisma.tag.updateMany({ where: { userId, name }, data: { color } });
  }

  /**
   * Increment (or create) Tag rows for each tag name.
   * Called after createMedia / createBatch to keep Tag counts in sync.
   */
  async upsertTags (userId: string, tags: string[]): Promise<void> {
    for (const name of tags) {
      if (!name) continue;
      await this.prisma.tag.upsert({
        where: { userId_name: { userId, name } },
        update: { count: { increment: 1 } },
        create: { userId, name, count: 1 },
      });
    }
  }
}
