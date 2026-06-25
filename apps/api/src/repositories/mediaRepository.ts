import path from "node:path";
import { Prisma, type PrismaClient, type TagOrigin } from "@prisma/client";
import { THUMBNAIL_TOO_LARGE_REASON, THUMBNAIL_UNSUPPORTED_REASON } from "../lib/media/processingSupport.js";

export type MediaListFilters = {
  userId: string;
  queryText?: string | null;
  tags?: string[];
  excludeTags?: string[];
  thumbState?: "PENDING" | "READY" | "ERROR" | "FAILED" | "UNSUPPORTED";
  textState?: "PENDING" | "READY" | "ERROR" | "FAILED" | "UNSUPPORTED";
  mimeTypePrefix?: string;
  orderBy: Prisma.MediaOrderByWithRelationInput[];
  take: number;
  cursor?: string | null;
  excludeUnpacked?: boolean;
};

/** The columns the delete worker needs to remove a media item (DB row + storage). */
export type MediaDeletionRow = {
  id: string;
  storageKey: string;
  thumbnailKey: string | null;
  sourcePath: string | null;
};

/**
 * Filter on a worker state via plain equality. Non-retriable "won't process"
 * items now carry the dedicated UNSUPPORTED state, so the "error" filters
 * (thumbState=FAILED / textState=ERROR) exclude them automatically — no sentinel
 * string or mimeType heuristic needed.
 */
function thumbStateWhereOrm (thumbState?: string): Prisma.MediaWhereInput {
  if (!thumbState) return {};
  return { thumbState: thumbState as Prisma.EnumMediaWorkerStateFilter };
}

function textStateWhereOrm (textState?: string): Prisma.MediaWhereInput {
  if (!textState) return {};
  return { textState: textState as Prisma.EnumMediaWorkerStateFilter };
}

export class MediaRepository {
  constructor (private readonly prisma: PrismaClient) {}

  /** Insert a new Media row and return its id, storageKey, and title.
   *  `autoTags` names the subset of `data.tags` the system applied (e.g. the
   *  MIME-type tag); those are recorded with origin AUTO, the rest as USER. */
  async createMedia (data: Prisma.MediaUncheckedCreateInput, opts?: { autoTags?: string[] }) {
    const media = await this.prisma.media.create({
      data,
      select: { id: true, storageKey: true, title: true },
    });

    // Sync Tag counts for initial tags.
    const tags = (data.tags as string[] | undefined) ?? [];
    await this.upsertTags(data.userId as string, tags, opts?.autoTags);

    return media;
  }

  /**
   * Bulk-insert Media rows without returning individual ids (used in batch
   * upload init and in-place indexing). `skipDuplicates` lets the index worker
   * tolerate a race on the (userId, sourcePath) unique index without failing
   * the whole batch.
   */
  async createBatch (
    items: Prisma.MediaCreateManyInput[],
    opts?: { skipDuplicates?: boolean; autoTagsByItem?: string[][] },
  ) {
    await this.prisma.media.createMany({ data: items, skipDuplicates: opts?.skipDuplicates ?? false });

    // Sync Tag counts: aggregate tags per userId across all items. A name is
    // treated as USER if it was user-supplied on any item; otherwise AUTO. User
    // intent wins, matching upsertTags' promotion rule.
    const tagsByUser = new Map<string, string[]>();
    const userNamesByUser = new Map<string, Set<string>>();
    items.forEach((item, i) => {
      const uid = item.userId as string;
      const tags = (item.tags as string[] | undefined) ?? [];
      const autoForItem = new Set(opts?.autoTagsByItem?.[i] ?? []);
      if (!tagsByUser.has(uid)) tagsByUser.set(uid, []);
      tagsByUser.get(uid)!.push(...tags);
      if (!userNamesByUser.has(uid)) userNamesByUser.set(uid, new Set());
      const userNames = userNamesByUser.get(uid)!;
      for (const t of tags) if (!autoForItem.has(t)) userNames.add(t);
    });
    for (const [uid, tags] of tagsByUser) {
      const userNames = userNamesByUser.get(uid) ?? new Set<string>();
      const autoNames = tags.filter(t => !userNames.has(t));
      await this.upsertTags(uid, tags, autoNames);
    }
  }

  async markSourcesReady (userId: string, ids: string[]) {
    // Raw SQL is required here: Prisma's updateMany does not support RETURNING,
    // and the returned rows (id + storageKey) are used by finalizeBatch to enqueue
    // OCR and thumbnail jobs. Switching to updateMany would silently drop those
    // values and break job enqueueing without a type error.
    return this.prisma.$queryRaw<{ id: string; storageKey: string; mimeType: string; sizeBytes: number }[]>`
      UPDATE "Media"
      SET "sourceState" = 'READY'
      WHERE "userId" = ${userId} AND "id" IN (${Prisma.join(ids)})
      RETURNING "id", "storageKey", "mimeType", "sizeBytes"
    `;
  }

  /**
   * Paginated media listing. When no tag filter is present the ORM path is
   * used (cursor + skip:1). When tags are present a single raw SQL query is
   * used so the case-insensitive array-containment check is inlined and no
   * unbounded IN list is materialised. Keyset pagination is used in that path.
   */
  async listMedia (filters: MediaListFilters) {
    if (filters.tags?.length || filters.excludeTags?.length || filters.queryText) return this._listMediaRaw(filters);
    return this._listMediaOrm(filters);
  }

  /** Count media matching the same filters as listMedia, ignoring pagination (take/cursor). */
  async countMedia (filters: MediaListFilters): Promise<number> {
    if (filters.tags?.length || filters.excludeTags?.length || filters.queryText) return this._countMediaRaw(filters);
    return this._countMediaOrm(filters);
  }

  /** Returns true if the user has any media items extracted from an archive. */
  async hasExtractedItems (userId: string): Promise<boolean> {
    const row = await this.prisma.media.findFirst({
      where: { userId, isExtractedFromArchive: true },
      select: { id: true },
    });
    return row !== null;
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
        ...thumbStateWhereOrm(thumbState),
        ...textStateWhereOrm(textState),
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

  /** Build the shared WHERE conditions for all raw media queries. Returns conditions, params,
   *  and the next available param index so callers can continue appending. */
  private _buildMediaFilterConditions (
    filters: Pick<MediaListFilters, "userId" | "queryText" | "tags" | "excludeTags" | "thumbState" | "textState" | "mimeTypePrefix" | "excludeUnpacked">
  ): { conditions: string[]; params: unknown[]; p: number } {
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
      conditions.push(`(m.title ILIKE $${p} OR EXISTS (SELECT 1 FROM "Document" d WHERE d."mediaId" = m.id AND d."searchVector" @@ plainto_tsquery('simple', $${p + 1})))`);
      params.push(`%${queryText}%`, queryText);
      p += 2;
    }
    // Plain equality on each state. The dedicated UNSUPPORTED state means the
    // "error" filters (thumbState=FAILED / textState=ERROR) already exclude
    // never-processable items — no sentinel string or mimeType heuristic needed.
    if (thumbState) {
      conditions.push(`m."thumbState" = $${p++}`);
      params.push(thumbState);
    }
    if (textState) {
      conditions.push(`m."textState" = $${p++}`);
      params.push(textState);
    }
    if (mimeTypePrefix) { conditions.push(`m."mimeType" LIKE $${p++}`); params.push(`${mimeTypePrefix}%`); }
    if (excludeUnpacked) conditions.push(`m."isExtractedFromArchive" = false`);

    return { conditions, params, p };
  }

  private async _listMediaRaw (filters: MediaListFilters) {
    const { orderBy, take, cursor } = filters;

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

    // Build shared WHERE conditions.
    const { conditions, params, p: pAfterFilters } = this._buildMediaFilterConditions(filters);
    let p = pAfterFilters;

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
        ...thumbStateWhereOrm(thumbState),
        ...textStateWhereOrm(textState),
        ...(mimeTypePrefix ? { mimeType: { startsWith: mimeTypePrefix } } : {}),
        ...(excludeUnpacked ? { isExtractedFromArchive: false } : {}),
      },
    });
  }

  private async _countMediaRaw (filters: MediaListFilters): Promise<number> {
    const { conditions, params } = this._buildMediaFilterConditions(filters);
    const sql = `SELECT COUNT(*)::int AS count FROM "Media" m WHERE ${conditions.join(" AND ")}`;
    const result = await this.prisma.$queryRawUnsafe<[{ count: number }]>(sql, ...params);
    return result[0]?.count ?? 0;
  }

  /** Return all media IDs matching the given filters — no pagination, used for bulk operations. */
  async listAllMediaIds (filters: Omit<MediaListFilters, "orderBy" | "take" | "cursor">): Promise<string[]> {
    const { tags, excludeTags, queryText } = filters;
    if (tags?.length || excludeTags?.length || queryText) return this._listAllMediaIdsRaw(filters);
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
        ...thumbStateWhereOrm(thumbState),
        ...textStateWhereOrm(textState),
        ...(mimeTypePrefix ? { mimeType: { startsWith: mimeTypePrefix } } : {}),
        ...(excludeUnpacked ? { isExtractedFromArchive: false } : {}),
      },
      select: { id: true },
    });
    return rows.map(r => r.id);
  }

  private async _listAllMediaIdsRaw (filters: Omit<MediaListFilters, "orderBy" | "take" | "cursor">): Promise<string[]> {
    const { conditions, params } = this._buildMediaFilterConditions(filters);
    const sql = `SELECT m.id FROM "Media" m WHERE ${conditions.join(" AND ")}`;
    const result = await this.prisma.$queryRawUnsafe<{ id: string }[]>(sql, ...params);
    return result.map(r => r.id);
  }

  // ---- Set-based bulk delete (used by the delete worker) -------------------

  /** Columns the delete worker needs per row: the PK plus the storage keys it
   *  must unlink. `sourcePath` is set on in-place indexed items — their original
   *  lives on the user's drive and must never be removed, only the thumbnail. */
  private static readonly DELETION_SELECT = {
    id: true,
    storageKey: true,
    thumbnailKey: true,
    sourcePath: true,
  } as const;

  /** Fetch up to `limit` rows matching the filter, for chunked deletion. Deleted
   *  rows drop out of the filter, so the worker can call this repeatedly until it
   *  returns empty — no keyset cursor needed and memory stays flat. */
  async listMediaForDeletion (
    filters: Omit<MediaListFilters, "orderBy" | "take" | "cursor">,
    limit: number,
  ): Promise<MediaDeletionRow[]> {
    const { tags, excludeTags, queryText } = filters;
    if (tags?.length || excludeTags?.length || queryText) {
      const { conditions, params } = this._buildMediaFilterConditions(filters);
      const sql = `SELECT m.id, m."storageKey", m."thumbnailKey", m."sourcePath" FROM "Media" m WHERE ${conditions.join(" AND ")} LIMIT $${params.length + 1}`;
      return this.prisma.$queryRawUnsafe<MediaDeletionRow[]>(sql, ...params, limit);
    }
    const { userId, thumbState, textState, mimeTypePrefix, excludeUnpacked } = filters;
    return this.prisma.media.findMany({
      where: {
        userId,
        ...thumbStateWhereOrm(thumbState),
        ...textStateWhereOrm(textState),
        ...(mimeTypePrefix ? { mimeType: { startsWith: mimeTypePrefix } } : {}),
        ...(excludeUnpacked ? { isExtractedFromArchive: false } : {}),
      },
      select: MediaRepository.DELETION_SELECT,
      take: limit,
    });
  }

  /** Count rows matching the filter — used once up front so the UI can show
   *  "deleting X of N". Mirrors the routing of listMediaForDeletion. */
  async countMediaForDeletion (
    filters: Omit<MediaListFilters, "orderBy" | "take" | "cursor">,
  ): Promise<number> {
    const { tags, excludeTags, queryText } = filters;
    if (tags?.length || excludeTags?.length || queryText) {
      const { conditions, params } = this._buildMediaFilterConditions(filters);
      const sql = `SELECT COUNT(m.id)::int AS count FROM "Media" m WHERE ${conditions.join(" AND ")}`;
      const rows = await this.prisma.$queryRawUnsafe<Array<{ count: number }>>(sql, ...params);
      return rows[0]?.count ?? 0;
    }
    const { userId, thumbState, textState, mimeTypePrefix, excludeUnpacked } = filters;
    return this.prisma.media.count({
      where: {
        userId,
        ...thumbStateWhereOrm(thumbState),
        ...textStateWhereOrm(textState),
        ...(mimeTypePrefix ? { mimeType: { startsWith: mimeTypePrefix } } : {}),
        ...(excludeUnpacked ? { isExtractedFromArchive: false } : {}),
      },
    });
  }

  /** Fetch deletion rows for a fixed set of ids (hand-picked multi-select).
   *  Scoped to userId so a caller can only delete their own media. */
  async findMediaForDeletionByIds (userId: string, ids: string[]): Promise<MediaDeletionRow[]> {
    if (ids.length === 0) return [];
    return this.prisma.media.findMany({
      where: { userId, id: { in: ids } },
      select: MediaRepository.DELETION_SELECT,
    });
  }

  /** Delete a chunk of media rows in one statement, scoped to the owning user so
   *  a stray id from another user can never be deleted (defense in depth — callers
   *  already pre-filter by userId). DB-level cascades remove the dependent
   *  BundleItem / Document / MediaExtractedMetadata rows and SetNull the
   *  Reminder / Bundle.sourceMediaId references. Returns the rows actually deleted.
   *  (userId is the second arg so the delete worker's injected port stays compatible.) */
  async deleteMediaByIds (ids: string[], userId: string): Promise<number> {
    if (ids.length === 0) return 0;
    const { count } = await this.prisma.media.deleteMany({ where: { id: { in: ids }, userId } });
    return count;
  }

  /** Return storageKey and thumbnailKey for a media item (used to delete S3 objects). */
  async findMediaKeys (userId: string, id: string) {
    return this.prisma.media.findFirst({
      where: { id, userId },
      select: { storageKey: true, thumbnailKey: true, sourcePath: true, mimeType: true },
    });
  }

  /** Info needed to stream an in-place original (GET /:id/source). */
  async findSourceInfo (userId: string, id: string) {
    return this.prisma.media.findFirst({
      where: { id, userId },
      select: { storageKey: true, sourcePath: true, mimeType: true, filename: true },
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
  async deleteAllMediaForUser (userId: string): Promise<Array<{ storageKey: string; thumbnailKey: string | null; sourcePath: string | null }>> {
    const items = await this.prisma.media.findMany({
      where: { userId },
      select: { storageKey: true, thumbnailKey: true, sourcePath: true },
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

        // Only newly-added names are treated as deliberate user actions: they are
        // recorded (or promoted) to origin USER. Tags merely retained keep their
        // origin, so re-saving an item without touching its auto tag never
        // silently converts that tag to user-made.
        for (const name of added) {
          await tx.tag.upsert({
            where: { userId_name: { userId, name } },
            update: { count: { increment: 1 }, origin: "USER" },
            create: { userId, name, count: 1, origin: "USER" },
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
      // System-applied (OCR/thumbnail) tag: AUTO on create, never demotes an
      // existing USER tag.
      await tx.tag.upsert({
        where: { userId_name: { userId: media.userId, name: tagName } },
        update: { count: { increment: 1 } },
        create: { userId: media.userId, name: tagName, count: 1, origin: "AUTO" },
      });
    });
  }

  async setContentHash (mediaId: string, hash: string): Promise<void> {
    await this.prisma.media.update({ where: { id: mediaId }, data: { contentHash: hash } });
  }

  async findDuplicateByHash (userId: string, hash: string, excludeId: string): Promise<{ id: string } | null> {
    return this.prisma.media.findFirst({
      where: { userId, contentHash: hash, id: { not: excludeId } },
      select: { id: true },
    });
  }

  async findStorageKey (userId: string, id: string) {
    return this.prisma.media.findFirst({
      where: { id, userId },
      select: { storageKey: true, sourcePath: true },
    });
  }

  async findBulkDownloadItems (userId: string, ids: string[]) {
    return this.prisma.media.findMany({
      where: { id: { in: ids }, userId },
      select: { id: true, storageKey: true, sourcePath: true, title: true, mimeType: true, filename: true },
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
      select: { id: true, storageKey: true, title: true, sourcePath: true, mimeType: true },
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
        sourcePath: true,
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
        reminders: {
          where: { status: 'ACTIVE' },
          select: { id: true, title: true, note: true, remindAt: true, dueAt: true },
          orderBy: { remindAt: 'asc' },
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
      select: { thumbnailKey: true, thumbState: true, mimeType: true, sourcePath: true, sizeBytes: true },
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
      select: { id: true, storageKey: true, sourcePath: true, mimeType: true, textState: true, sizeBytes: true },
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

  async setTextState (mediaId: string, state: "PENDING" | "READY" | "ERROR" | "UNSUPPORTED"): Promise<boolean> {
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
  /**
   * Given a list of absolute source paths, return the subset already indexed by
   * this user. Used by the index worker to skip files that already have a Media
   * row before inserting (the (userId, sourcePath) unique index is the backstop).
   */
  async findExistingSourcePaths (userId: string, paths: string[]): Promise<Set<string>> {
    if (paths.length === 0) return new Set();
    const rows = await this.prisma.media.findMany({
      where: { userId, sourcePath: { in: paths } },
      select: { sourcePath: true },
    });
    return new Set(rows.map(r => r.sourcePath).filter((p): p is string => p !== null));
  }

  /** The Media id for an in-place item at this exact source path, or null. Used
   *  by the live watcher to resolve an `unlink` event to the row to delete. */
  async findIdBySourcePath (userId: string, sourcePath: string): Promise<string | null> {
    const row = await this.prisma.media.findFirst({
      where: { userId, sourcePath },
      select: { id: true },
    });
    return row?.id ?? null;
  }

  /** Media ids for in-place items whose source path sits under `prefix` (a
   *  removed directory). The trailing separator prevents `/a/b` from matching
   *  a sibling `/a/bc`. Uses the OS separator so it matches the backslash paths
   *  stored on Windows (path.join output), not just POSIX `/`. Used by the
   *  watcher's `unlinkDir` handler. */
  async findIdsBySourcePathPrefix (userId: string, prefix: string): Promise<string[]> {
    const withSep = prefix.endsWith(path.sep) ? prefix : prefix + path.sep;
    const rows = await this.prisma.media.findMany({
      where: { userId, sourcePath: { startsWith: withSep } },
      select: { id: true },
    });
    return rows.map(r => r.id);
  }

  /** All in-place source paths for a user (with their id), for reconciliation
   *  pruning of rows whose original no longer exists on disk. */
  async listSourcePaths (userId: string): Promise<Array<{ id: string; sourcePath: string }>> {
    const rows = await this.prisma.media.findMany({
      where: { userId, sourcePath: { not: null } },
      select: { id: true, sourcePath: true },
    });
    return rows
      .filter((r): r is { id: string; sourcePath: string } => r.sourcePath !== null);
  }

  async markTextUnsupported (mediaIds: string[]): Promise<void> {
    if (mediaIds.length === 0) return;
    await this.prisma.media.updateMany({
      where: { id: { in: mediaIds }, textState: "PENDING" },
      data: { textState: "UNSUPPORTED" },
    });
  }

  /** Marks thumbState PENDING → UNSUPPORTED for items whose type can't be
   *  thumbnailed, so they never run a doomed thumbnail job. Guards on PENDING to
   *  avoid a retrograde READY → UNSUPPORTED write. The reason is persisted to
   *  thumbError for display. */
  async markThumbUnsupported (mediaIds: string[]): Promise<void> {
    if (mediaIds.length === 0) return;
    await this.prisma.media.updateMany({
      where: { id: { in: mediaIds }, thumbState: "PENDING" },
      data: { thumbState: "UNSUPPORTED", thumbError: THUMBNAIL_UNSUPPORTED_REASON },
    });
  }

  /** Mark rows whose source is too large to thumbnail (see MAX_THUMBNAIL_BYTES).
   *  Used at enqueue time so a doomed thumb job is never created. */
  async markThumbTooLarge (mediaIds: string[]): Promise<void> {
    if (mediaIds.length === 0) return;
    await this.prisma.media.updateMany({
      where: { id: { in: mediaIds }, thumbState: "PENDING" },
      data: { thumbState: "UNSUPPORTED", thumbError: THUMBNAIL_TOO_LARGE_REASON },
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
        select: { name: true, count: true, color: true, origin: true },
      }),
      this.prisma.tag.count({ where: { userId } }),
    ]);
    return {
      tags: rows.map(r => ({ tag: r.name, count: r.count, color: r.color ?? null, origin: r.origin })),
      total,
    };
  }

  /**
   * Minimal per-file size data for the entire vault, largest first. Powers the
   * storage treemap, which needs every file's relative size — not just a page.
   * Backed by the [userId, sizeBytes desc] index; zero-byte rows are skipped
   * since they contribute no area.
   */
  async listAllMediaSizes (userId: string) {
    return this.prisma.media.findMany({
      where: { userId, sizeBytes: { gt: 0 } },
      select: { id: true, title: true, filename: true, mimeType: true, sizeBytes: true },
      orderBy: [{ sizeBytes: "desc" }, { id: "desc" }],
    });
  }

  async getMediaStats (userId: string) {
    const [agg, breakdown] = await this.prisma.$transaction([
      this.prisma.media.aggregate({
        where: { userId },
        _count: { _all: true },
        _sum: { sizeBytes: true },
      }),
      this.prisma.$queryRaw<Array<{ mimeType: string; count: bigint }>>`
        SELECT "mimeType", COUNT(*)::bigint AS count
        FROM "Media"
        WHERE "userId" = ${userId}
        GROUP BY "mimeType"
        ORDER BY COUNT(*) DESC
        LIMIT 20
      `,
    ]);
    return {
      totalDocs: agg._count._all,
      storageBytes: Number(agg._sum.sizeBytes ?? 0),
      typeBreakdown: breakdown.map(r => ({ mimeType: r.mimeType, count: Number(r.count) })),
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

  /** Set the origin (USER/AUTO) on a tag row — the manual override from settings. */
  async setTagOrigin (userId: string, name: string, origin: TagOrigin): Promise<void> {
    await this.prisma.tag.updateMany({ where: { userId, name }, data: { origin } });
  }

  /** Return the subset of `tagNames` whose Tag row is AUTO for this user. */
  async listAutoTagNames (userId: string, tagNames: string[]): Promise<string[]> {
    if (tagNames.length === 0) return [];
    const rows = await this.prisma.tag.findMany({
      where: { userId, name: { in: tagNames }, origin: "AUTO" },
      select: { name: true },
    });
    return rows.map(r => r.name);
  }

  /**
   * Increment (or create) Tag rows for each tag name.
   * Called after createMedia / createBatch to keep Tag counts in sync.
   * Names listed in `autoTags` are recorded with origin AUTO on creation; all
   * other names default to USER, and a user-supplied name promotes an existing
   * AUTO row to USER (never the reverse).
   */
  async upsertTags (userId: string, tags: string[], autoTags?: Iterable<string>): Promise<void> {
    const autoSet = new Set(autoTags ?? []);
    for (const name of tags) {
      if (!name) continue;
      const isAuto = autoSet.has(name);
      await this.prisma.tag.upsert({
        where: { userId_name: { userId, name } },
        update: isAuto ? { count: { increment: 1 } } : { count: { increment: 1 }, origin: "USER" },
        create: { userId, name, count: 1, origin: isAuto ? "AUTO" : "USER" },
      });
    }
  }
}
