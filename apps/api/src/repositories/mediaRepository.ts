import path from "node:path";
import { Prisma, type PrismaClient, type TagOrigin, type TextSource } from "@prisma/client";
import { THUMBNAIL_TOO_LARGE_REASON, THUMBNAIL_UNSUPPORTED_REASON } from "../lib/media/processingSupport.js";
import { normalizeTags } from "../lib/tags/normalizeTags.js";
import { isDedupStrictOrder } from "../lib/config/dedup.js";

/**
 * Every Prisma call that touches a Media row. Routes and services never query
 * the database themselves, so the filters, the keyset pagination and the state
 * guards are all written once, here.
 */

export type MediaListFilters = {
  userId: string;
  queryText?: string | null;
  tags?: string[];
  excludeTags?: string[];
  thumbState?: "PENDING" | "READY" | "ERROR" | "FAILED" | "UNSUPPORTED";
  /** NEEDS_OCR backs the library's "Scanned — text not extracted yet" filter. */
  textState?: "PENDING" | "READY" | "ERROR" | "FAILED" | "UNSUPPORTED" | "NEEDS_OCR";
  mimeTypePrefix?: string;
  orderBy: Prisma.MediaOrderByWithRelationInput[];
  take: number;
  cursor?: string | null;
  excludeUnpacked?: boolean;
  /** "only" restricts to items whose source file has vanished — the library's
   *  "Missing files" view. Unset shows everything, missing items included, so
   *  they stay visible (and flagged) rather than silently disappearing. */
  missing?: "only";
};

/** A tombstoned row offered to `matchIdentity` as a possible move source. Adds
 *  `titleIsUserEdited` to the matcher's shape so the caller can decide whether a
 *  rename may overwrite the title. */
export type MoveCandidateRow = {
  id: string;
  basename: string;
  sizeBytes: number;
  mtimeMs: number | null;
  contentHash: string | null;
  titleIsUserEdited: boolean;
};

/** A freshly-indexed live row, offered as a move *target* when the watcher sees
 *  the move's `add` before its `unlink`. */
export type RecentlyIndexedRow = {
  id: string;
  sourcePath: string;
  filename: string;
  basename: string;
  sizeBytes: number;
  mtimeMs: number | null;
  contentHash: string | null;
};

/** One in-place row as the reconcile sweep sees it: enough to stat the source
 *  and decide missing / changed / unchanged without a second query. */
export type ReconcileEntry = {
  id: string;
  sourcePath: string;
  mimeType: string;
  storageKey: string | null;
  sizeBytes: number;
  mtimeMs: number | null;
  fileDate: Date | null;
  missingSince: Date | null;
};

/** The columns the delete worker needs to remove a media item (DB row + storage). */
export type MediaDeletionRow = {
  id: string;
  storageKey: string | null;
  thumbnailKey: string | null;
  sourcePath: string | null;
};

/** Per-state row counts for one derivative, scoped to a user. */
export type DerivativeProgressCounts = {
  thumb: { pending: number; ready: number; failed: number; unsupported: number };
  text: { pending: number; ready: number; needsOcr: number; error: number; unsupported: number };
  hash: { pending: number; ready: number; unsupported: number };
};

/**
 * Filters on a worker state by plain equality. An item that will never be
 * processed carries UNSUPPORTED, so the error filters exclude it without a
 * sentinel value or a guess from its MIME type.
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

  /** Inserts a Media row and returns its id, storage key and title. `autoTags`
   *  names the tags in `data.tags` the system applied; those are recorded with
   *  origin AUTO, and the rest as USER. */
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
   * Inserts many Media rows, returning no ids. `skipDuplicates` lets the index
   * worker survive a race on the (userId, sourcePath) unique index without
   * losing the whole batch.
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

  /**
   * Returns one page of a user's media. Without a tag filter it goes through the
   * ORM. With one it takes a single raw query, so the case-insensitive array
   * check stays inline and no unbounded IN list is built; that path paginates
   * by keyset.
   */
  async listMedia (filters: MediaListFilters) {
    // fileDate is nullable; Prisma cursor pagination over a nullable order
    // column is unreliable, so that sort always takes the raw keyset path
    // (which orders NULLS LAST with a null-aware cursor comparison).
    const isFileDateSort = "fileDate" in (filters.orderBy[0] ?? {});
    if (isFileDateSort || filters.tags?.length || filters.excludeTags?.length || filters.queryText) return this._listMediaRaw(filters);
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
    const { userId, queryText, excludeTags, thumbState, textState, mimeTypePrefix, orderBy, take, cursor, excludeUnpacked, missing } = filters;
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
        ...(missing === "only" ? { missingSince: { not: null } } : {}),
      },
      orderBy,
      take,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true, title: true, filename: true,
        thumbState: true, textState: true, createdAt: true, fileDate: true,
        tags: true, mimeType: true, sizeBytes: true, starred: true, missingSince: true,
      },
    });
  }

  /** Build the shared WHERE conditions for all raw media queries. Returns conditions, params,
   *  and the next available param index so callers can continue appending. */
  private _buildMediaFilterConditions (
    filters: Pick<MediaListFilters, "userId" | "queryText" | "tags" | "excludeTags" | "thumbState" | "textState" | "mimeTypePrefix" | "excludeUnpacked" | "missing">
  ): { conditions: string[]; params: unknown[]; p: number } {
    const { userId, queryText, tags, excludeTags, thumbState, textState, mimeTypePrefix, excludeUnpacked, missing } = filters;
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
    // Plain equality on each state — same rationale as `thumbStateWhereOrm`.
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
    if (missing === "only") conditions.push(`m."missingSince" IS NOT NULL`);

    return { conditions, params, p };
  }

  private async _listMediaRaw (filters: MediaListFilters) {
    const { orderBy, take, cursor } = filters;

    // Derive sort column and direction from the Prisma orderBy structure.
    // buildOrderBy always puts the primary column first; the tiebreaker id last.
    const [[sortField, sortDir]] = Object.entries(orderBy[0]) as [[string, "asc" | "desc"]];

    // "Starred first" is a three-level sort (starred DESC, createdAt DESC, id
    // DESC). All directions match, so the keyset condition can use a Postgres
    // row-value comparison instead of the generic two-level expansion below.
    const isStarredSort = sortField === "starred";
    // fileDate is the one nullable sort column: it orders NULLS LAST and needs
    // a null-aware keyset comparison (the generic row expansion below never
    // matches once the cursor or row value is NULL).
    const isFileDateSort = sortField === "fileDate";

    // Map camelCase field names to quoted Postgres column identifiers.
    // These come from a closed enum in buildOrderBy — never from user input.
    const COL: Record<string, string> = {
      createdAt: '"createdAt"',
      title: "title",
      sizeBytes: '"sizeBytes"',
      mimeType: '"mimeType"',
      fileDate: '"fileDate"',
    };
    const col = COL[sortField] ?? '"createdAt"';
    const dir = sortDir === "asc" ? "ASC" : "DESC";
    const cmp = sortDir === "asc" ? ">" : "<";

    // Keyset cursor: look up the cursor row's sort-column value(s) by PK (fast).
    let cursorRow: Record<string, unknown> | null = null;
    if (cursor) {
      cursorRow = await this.prisma.media.findFirst({
        where: { id: cursor },
        select: isStarredSort
          ? { id: true, starred: true, createdAt: true }
          : { id: true, [sortField]: true },
      }) as Record<string, unknown> | null;
      if (!cursorRow) return [];
    }

    // Build shared WHERE conditions.
    const { conditions, params, p: pAfterFilters } = this._buildMediaFilterConditions(filters);
    let p = pAfterFilters;

    if (cursorRow !== null) {
      if (isStarredSort) {
        conditions.push(`(m.starred, m."createdAt", m.id) < ($${p}, $${p + 1}, $${p + 2})`);
        params.push(cursorRow.starred, cursorRow.createdAt, cursorRow.id);
        p += 3;
      } else if (isFileDateSort && cursorRow[sortField] === null) {
        // Cursor sits inside the trailing NULL block — compare by id alone.
        conditions.push(`(m.${col} IS NULL AND m.id ${cmp} $${p})`);
        params.push(cursorRow.id);
        p += 1;
      } else if (isFileDateSort) {
        // Cursor in the non-null block: rows after it are strictly-past values,
        // same-value/later-id ties, and the entire trailing NULL block.
        conditions.push(`(m.${col} ${cmp} $${p} OR (m.${col} = $${p} AND m.id ${cmp} $${p + 1}) OR m.${col} IS NULL)`);
        params.push(cursorRow[sortField], cursorRow.id);
        p += 2;
      } else {
        // Keyset: (col, id) cmp (cursorColVal, cursorId). $p is reused for col equality.
        conditions.push(`(m.${col} ${cmp} $${p} OR (m.${col} = $${p} AND m.id ${cmp} $${p + 1}))`);
        params.push(cursorRow[sortField], cursorRow.id);
        p += 2;
      }
    }

    params.push(take);

    const orderSql = isStarredSort
      ? `m.starred DESC, m."createdAt" DESC, m.id DESC`
      : isFileDateSort
        ? `m.${col} ${dir} NULLS LAST, m.id ${dir}`
        : `m.${col} ${dir}, m.id ${dir}`;

    const sql = `
      SELECT m.id, m.title, m.filename, m."thumbState", m."textState", m."createdAt", m."fileDate", m.tags, m."mimeType", m."sizeBytes", m.starred, m."missingSince"
      FROM "Media" m
      WHERE ${conditions.join(" AND ")}
      ORDER BY ${orderSql}
      LIMIT $${p}
    `;

    return this.prisma.$queryRawUnsafe<Array<{
      id: string; title: string; filename: string;
      thumbState: string; textState: string;
      createdAt: Date; fileDate: Date | null; tags: string[]; mimeType: string; sizeBytes: number; starred: boolean;
    }>>(sql, ...params);
  }

  private async _countMediaOrm (filters: MediaListFilters): Promise<number> {
    const { userId, queryText, excludeTags, thumbState, textState, mimeTypePrefix, excludeUnpacked, missing } = filters;
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
        ...(missing === "only" ? { missingSince: { not: null } } : {}),
      },
    });
  }

  private async _countMediaRaw (filters: MediaListFilters): Promise<number> {
    const { conditions, params } = this._buildMediaFilterConditions(filters);
    const sql = `SELECT COUNT(*)::int AS count FROM "Media" m WHERE ${conditions.join(" AND ")}`;
    const result = await this.prisma.$queryRawUnsafe<[{ count: number }]>(sql, ...params);
    return result[0]?.count ?? 0;
  }

  /** Returns every media id matching the filters, unpaginated. */
  async listAllMediaIds (filters: Omit<MediaListFilters, "orderBy" | "take" | "cursor">): Promise<string[]> {
    const { tags, excludeTags, queryText } = filters;
    if (tags?.length || excludeTags?.length || queryText) return this._listAllMediaIdsRaw(filters);
    return this._listAllMediaIdsOrm(filters);
  }

  private async _listAllMediaIdsOrm (filters: Omit<MediaListFilters, "orderBy" | "take" | "cursor">): Promise<string[]> {
    const { userId, queryText, excludeTags, thumbState, textState, mimeTypePrefix, excludeUnpacked, missing } = filters;
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
        ...(missing === "only" ? { missingSince: { not: null } } : {}),
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

  // Set-based bulk delete, used by the delete worker.

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
    const { userId, thumbState, textState, mimeTypePrefix, excludeUnpacked, missing } = filters;
    return this.prisma.media.findMany({
      where: {
        userId,
        ...thumbStateWhereOrm(thumbState),
        ...textStateWhereOrm(textState),
        ...(mimeTypePrefix ? { mimeType: { startsWith: mimeTypePrefix } } : {}),
        ...(excludeUnpacked ? { isExtractedFromArchive: false } : {}),
        ...(missing === "only" ? { missingSince: { not: null } } : {}),
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
    const { userId, thumbState, textState, mimeTypePrefix, excludeUnpacked, missing } = filters;
    return this.prisma.media.count({
      where: {
        userId,
        ...thumbStateWhereOrm(thumbState),
        ...textStateWhereOrm(textState),
        ...(mimeTypePrefix ? { mimeType: { startsWith: mimeTypePrefix } } : {}),
        ...(excludeUnpacked ? { isExtractedFromArchive: false } : {}),
        ...(missing === "only" ? { missingSince: { not: null } } : {}),
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
   *  Reminder / Bundle.sourceMediaId references. Returns the count of rows deleted.
   *  (userId is the second arg so the delete worker's injected port stays compatible.) */
  async deleteMediaByIds (ids: string[], userId: string): Promise<number> {
    if (ids.length === 0) return 0;
    const { count } = await this.prisma.media.deleteMany({ where: { id: { in: ids }, userId } });
    return count;
  }

  /** Returns the storage keys for an item, so its stored objects can be
   *  removed with it. */
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

  /** Deletes all of a user's media in four queries, and returns the storage
   *  keys the caller still has to remove. Database cascades take care of
   *  BundleItem, Document and MediaExtractedMetadata, and null out
   *  Reminder.mediaId and Bundle.sourceMediaId. Bundle.coverMediaId carries no
   *  foreign key and is cleared here. */
  async deleteAllMediaForUser (userId: string): Promise<Array<{ storageKey: string | null; thumbnailKey: string | null; sourcePath: string | null }>> {
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

  /** Recomputes Tag.count from the Media rows themselves, and deletes a tag no
   *  row still carries. Run it after a bulk delete, where concurrent
   *  transactions leave the counts behind. */
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

  /** Total media rows the organize worker will consider for a user. */
  async countMediaForOrganize (userId: string): Promise<number> {
    return this.prisma.media.count({ where: { userId } });
  }

  /** One keyset page of media rows for the organize worker, with the extracted
   *  metadata joined in, which is where an EXIF or PDF date is held. Ordered by
   *  id, so the worker resumes from the last id of the previous page. */
  async listMediaForOrganize (userId: string, afterId: string | null, limit: number) {
    const rows = await this.prisma.media.findMany({
      where: { userId, ...(afterId ? { id: { gt: afterId } } : {}) },
      orderBy: { id: "asc" },
      take: limit,
      select: {
        id: true,
        title: true,
        filename: true,
        mimeType: true,
        sizeBytes: true,
        sourcePath: true,
        isExtractedFromArchive: true,
        tags: true,
        fileDate: true,
        extractedMetadata: { select: { data: true } },
      },
    });
    return rows.map(({ extractedMetadata, ...row }) => ({
      ...row,
      metadata: extractedMetadata?.data ?? null,
    }));
  }

  /** Append tags to a media row, skipping any already present. Raw SQL so the
   *  append + dedup is one atomic statement — a concurrent tag edit can't
   *  produce `['a','a']` the way a read-modify-write could. Does NOT touch
   *  Tag.count; callers run ensureAutoTagRows + reconcileTagCounts afterwards. */
  async addTagsToMedia (userId: string, mediaId: string, tags: string[]): Promise<void> {
    if (tags.length === 0) return;
    await this.prisma.$executeRaw`
      UPDATE "Media" m
      SET tags = m.tags || ARRAY(
        SELECT t FROM unnest(${tags}::text[]) AS t
        WHERE NOT t = ANY(m.tags)
      )
      WHERE m."id" = ${mediaId} AND m."userId" = ${userId}
    `;
  }

  /** Ensure a Tag row exists for each name (origin AUTO, count 0 — the caller's
   *  reconcileTagCounts pass sets real counts). Existing rows are untouched. */
  async ensureAutoTagRows (userId: string, names: string[]): Promise<void> {
    if (names.length === 0) return;
    await this.prisma.tag.createMany({
      data: names.map(name => ({ userId, name, count: 0, origin: "AUTO" as const })),
      skipDuplicates: true,
    });
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
      // A title set here came from the user, so latch titleIsUserEdited: if the
      // file is later moved or renamed on disk, the rematch must keep this title
      // instead of re-deriving one from the new filename.
      ...(data.title !== undefined ? { title: data.title, titleIsUserEdited: true } : {}),
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
    // Worker-applied tags ("has-text", "duplicate") must obey the same ruleset
    // as user tags — a raw literal here would bypass the lowercase invariant
    // the tag filter and count machinery assume.
    [tagName] = normalizeTags(tagName);
    if (!tagName) return;
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

  /**
   * Terminal write for an explicit hash job. Guards on hashState = PENDING —
   * same rationale as {@link setThumbFailed}/{@link setTextState} — so a late
   * worker can't overwrite a state stall detection has already resolved.
   */
  async setHashState (mediaId: string, state: "READY" | "FAILED"): Promise<boolean> {
    const result = await this.prisma.media.updateMany({
      where: { id: mediaId, hashState: "PENDING" },
      data: { hashState: state },
    });
    return result.count > 0;
  }

  /** Persist the resolved file date (EXIF capture → PDF created → fs mtime). */
  async setFileDate (mediaId: string, fileDate: Date): Promise<void> {
    await this.prisma.media.update({ where: { id: mediaId }, data: { fileDate } });
  }

  async findDuplicateByHash (userId: string, hash: string, excludeId: string): Promise<{ id: string } | null> {
    return this.prisma.media.findFirst({
      where: { userId, contentHash: hash, id: { not: excludeId } },
      select: { id: true },
    });
  }

  /** All members of duplicate contentHash groups (2+ items sharing a hash).
   *  Ordered by hash so the dedup service can assemble groups in one walk. */
  async listDuplicateMembers (userId: string) {
    const groups = await this.prisma.media.groupBy({
      by: ["contentHash"],
      where: { userId, contentHash: { not: null } },
      having: { contentHash: { _count: { gt: 1 } } },
    });
    const hashes = groups.map(g => g.contentHash).filter((h): h is string => h !== null);
    if (hashes.length === 0) return [];
    return this.prisma.media.findMany({
      where: { userId, contentHash: { in: hashes } },
      orderBy: [{ contentHash: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      select: {
        id: true, title: true, filename: true, mimeType: true, sizeBytes: true,
        sourcePath: true, createdAt: true, thumbState: true, thumbnailKey: true,
        contentHash: true,
      },
    });
  }

  /** READY items still lacking a contentHash (candidates for a dedup scan).
   *  Non-READY rows are skipped — their source bytes may not exist yet. */
  async countUnhashed (userId: string): Promise<number> {
    return this.prisma.media.count({
      where: { userId, contentHash: null, sourceState: "READY" },
    });
  }

  /** One keyset page of unhashed READY rows for dedup-scan enqueueing. */
  async listUnhashedPage (userId: string, afterId: string | null, limit: number) {
    return this.prisma.media.findMany({
      where: {
        userId,
        contentHash: null,
        sourceState: "READY",
        ...(afterId ? { id: { gt: afterId } } : {}),
      },
      orderBy: { id: "asc" },
      take: limit,
      select: { id: true, storageKey: true, sourcePath: true },
    });
  }

  /**
   * Flip every unhashed READY row back to hashState PENDING with a cleared
   * dispatch stamp, so the feeder claims them — the dedup scan no longer pushes
   * hash jobs itself. `hashState <> 'PENDING'` excludes rows already PENDING
   * (either genuinely unclaimed already, or claimed with a stamp in flight);
   * clearing the stamp on the latter would let the feeder double-dispatch.
   * Returns the number of rows reset.
   */
  async resetUnhashedForScan (userId: string): Promise<number> {
    const result = await this.prisma.media.updateMany({
      where: { userId, contentHash: null, sourceState: "READY", hashState: { not: "PENDING" } },
      data: { hashState: "PENDING", hashQueuedAt: null },
    });
    return result.count;
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

  /** Just enough to decide which of a freshly-ingested batch are archives. */
  async findMimeTypesByIds (userId: string, ids: string[]) {
    return this.prisma.media.findMany({
      where: { id: { in: ids }, userId },
      select: { id: true, mimeType: true },
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
      // textState is selected so the caller can tell a deferred scan (NEEDS_OCR)
      // from a plain re-run: on the former, "extract text" must force tier 2.
      select: { id: true, storageKey: true, title: true, sourcePath: true, mimeType: true, textState: true },
    });
  }

  /**
   * Transition textState to PENDING for a user-triggered re-run.
   * Allowed from PENDING, READY, or ERROR. Returns false only if the row
   * doesn't exist or is in an unexpected state (shouldn't happen in practice).
   */
  async setTextStatePending (id: string): Promise<boolean> {
    const result = await this.prisma.media.updateMany({
      // NEEDS_OCR included: "Extract text" on a deferred scan is the main way a
      // user starts tier-2 OCR when ocrMode is onDemand.
      where: { id, textState: { in: ["PENDING", "READY", "ERROR", "NEEDS_OCR"] } },
      // Stamped, not cleared: the caller enqueues this one directly (push), so
      // the feeder must not pick it up a second time.
      data: { textState: "PENDING", textQueuedAt: new Date() },
    });
    return result.count > 0;
  }

  /** How many of the user's rows are parked waiting for tier-2 OCR. Backs the
   *  "Extract all" count — this is the same set the library's
   *  "Scanned — text not extracted" filter shows. */
  async countNeedsOcr (userId: string): Promise<number> {
    return this.prisma.media.count({ where: { userId, textState: "NEEDS_OCR" } });
  }

  /**
   * Claim a bounded batch of NEEDS_OCR rows for tier-2 extraction: flip them to
   * PENDING and hand back what the caller needs to build the jobs.
   *
   * Raw SQL because this must be one statement. Prisma's updateMany has no
   * RETURNING, so the alternative is select-then-update — and in that gap two
   * concurrent "Extract all" presses (or a press racing the background sweeper)
   * both claim the same rows and enqueue them twice. `FOR UPDATE SKIP LOCKED`
   * makes concurrent callers take disjoint batches instead of blocking.
   *
   * `textQueuedAt` is stamped in the same statement that flips the state: the
   * caller enqueues on ocr_queue itself, and a PENDING row with a NULL stamp is
   * what the feeder claims, so leaving it would re-run tier 1 over the top.
   */
  async claimNeedsOcrBatch (userId: string, limit: number) {
    return this.prisma.$queryRaw<
      { id: string; storageKey: string | null; sourcePath: string | null; title: string }[]
    >`
      UPDATE "Media"
      SET "textState" = 'PENDING', "textQueuedAt" = NOW()
      WHERE "id" IN (
        SELECT "id" FROM "Media"
        WHERE "userId" = ${userId} AND "textState" = 'NEEDS_OCR'
        ORDER BY "createdAt" DESC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING "id", "storageKey", "sourcePath", "title"
    `;
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
        starred: true,
        thumbState: true,
        thumbError: true,
        textState: true,
        // PENDING alone can't tell the detail panel whether extraction is
        // running or still queued — a NULL stamp is the backlog.
        textQueuedAt: true,
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

  /** A READY thumbnail belonging to another row with the same contentHash — the
   *  reuse candidate for thumbnailService's copy-not-render path. Covered by
   *  the existing @@index([userId, contentHash]). */
  async findReusableThumbnail (userId: string, contentHash: string, excludeId: string): Promise<{ id: string; thumbnailKey: string } | null> {
    const row = await this.prisma.media.findFirst({
      where: { userId, contentHash, id: { not: excludeId }, thumbState: "READY", thumbnailKey: { not: null } },
      select: { id: true, thumbnailKey: true },
    });
    if (!row?.thumbnailKey) return null;
    return { id: row.id, thumbnailKey: row.thumbnailKey };
  }

  /**
   * Atomically mark the thumbnail as ready and store its key.
   * Guards on thumbState = PENDING so a late-arriving worker can't overwrite
   * a FAILED state (e.g. after retry exhaustion) with READY.
   * Returns false if the guard prevented the update.
   */
  async setThumbReady (mediaId: string, thumbnailKey: string): Promise<boolean> {
    const result = await this.prisma.media.updateMany({
      where: { id: mediaId, thumbState: "PENDING" },
      data: { thumbnailKey, thumbState: "READY", thumbError: null },
    });
    return result.count > 0;
  }

  /**
   * Clear thumbnailKey and reset thumbState to PENDING.
   *
   * Reset for a *push* re-run: `regenerateThumbnail` adds the job itself, so the
   * dispatch stamp is set here rather than cleared. Clearing it would hand the
   * same row to the feeder as well, and `regenerateThumbnail` uses a timestamped
   * jobId — so BullMQ's dedup would not catch the second job.
   */
  async resetThumbState (mediaId: string): Promise<boolean> {
    const result = await this.prisma.media.updateMany({
      where: { id: mediaId },
      data: { thumbnailKey: null, thumbState: "PENDING", thumbError: null, thumbQueuedAt: new Date() },
    });
    return result.count > 0;
  }

  /**
   * Mark thumbnail generation as permanently failed and store the sanitized error message.
   * Guards on thumbState = PENDING to prevent retrograde READY → FAILED writes.
   */
  async setThumbFailed (mediaId: string, error: string): Promise<boolean> {
    const result = await this.prisma.media.updateMany({
      where: { id: mediaId, thumbState: "PENDING" },
      data: { thumbState: "FAILED", thumbError: error },
    });
    return result.count > 0;
  }

  async findForOcr (mediaId: string) {
    return this.prisma.media.findUnique({
      where: { id: mediaId },
      select: { id: true, userId: true, storageKey: true, sourcePath: true, mimeType: true, textState: true, sizeBytes: true, contentHash: true },
    });
  }

  /** A READY, byte-identical row's extracted text — the reuse candidate for
   *  ocrProcessingService's copy-not-reprocess path. Covered by the existing
   *  @@index([userId, contentHash]). */
  async findReusableDocument (
    userId: string,
    contentHash: string,
    excludeId: string,
  ): Promise<{ id: string; rawText: string; pages: Prisma.JsonValue; textSource: TextSource | null } | null> {
    const row = await this.prisma.media.findFirst({
      where: { userId, contentHash, id: { not: excludeId }, textState: "READY" },
      select: { id: true, document: { select: { rawText: true, pages: true, textSource: true } } },
    });
    if (!row?.document) return null;
    return { id: row.id, rawText: row.document.rawText, pages: row.document.pages, textSource: row.document.textSource };
  }

  /** Returns an item's current textState, which a worker reads to notice a
   *  cancellation before it starts. */
  async getTextState (mediaId: string) {
    const media = await this.prisma.media.findUnique({
      where: { id: mediaId },
      select: { textState: true },
    });
    return media?.textState ?? null;
  }

  async setTextState (mediaId: string, state: "PENDING" | "READY" | "ERROR" | "UNSUPPORTED" | "NEEDS_OCR"): Promise<boolean> {
    // Guard: worker-initiated writes are only allowed from a state that means
    // "extraction is legitimately outstanding" — PENDING, or NEEDS_OCR for a
    // deferred OCR job finally running. This prevents a late worker from
    // overwriting a cancel or stall-detection ERROR with READY, while still
    // letting tier-2 OCR complete a row it parked at NEEDS_OCR itself.
    const result = await this.prisma.media.updateMany({
      where: { id: mediaId, textState: { in: ["PENDING", "NEEDS_OCR"] } },
      data: { textState: state },
    });
    return result.count > 0;
  }

  // Stall detection.

  /**
   * Rows whose dispatched derivative job never reported back.
   *
   * Keyed on the dispatch stamp, not `updatedAt`. Under the pull model most of a
   * large library sits at PENDING with a NULL stamp for hours or days by design
   * — it is waiting for the feeder, not stalled — and an `updatedAt` clock would
   * mark the entire backlog FAILED/ERROR fifteen minutes into the first index.
   * `updatedAt` was the wrong signal even before the feeder existed: retagging an
   * item bumps it and silently reset the stall clock on a stuck job.
   */
  async findStalledMedia (staleBefore: Date) {
    return this.prisma.media.findMany({
      where: {
        OR: [
          { thumbState: "PENDING", thumbQueuedAt: { not: null, lt: staleBefore } },
          { textState: "PENDING", textQueuedAt: { not: null, lt: staleBefore } },
          { hashState: "PENDING", hashQueuedAt: { not: null, lt: staleBefore } },
        ],
      },
      select: { id: true, thumbState: true, textState: true, hashState: true },
    });
  }

  /**
   * The feeder's eligibility test, as one fragment.
   *
   * Every claim and anything that has to agree with one — the by-id promotions
   * and {@link countTextBacklogAhead}'s queue position — reads this same
   * definition. A second copy of the list drifts the first time either is
   * edited: spelling it out inline in the by-id claims is what let promotion
   * walk rows past the DEDUP_STRICT_ORDER barrier while the position count
   * still honoured it.
   *
   * `sourceState = READY` excludes an upload whose bytes have not finished writing yet;
   * dispatching one burns every attempt on SOURCE_NOT_READY and files it FAILED.
   * `missingSince IS NULL` excludes a tombstoned source: nothing on disk to read.
   */
  private derivativeEligible (
    column: "thumbQueuedAt" | "textQueuedAt" | "hashQueuedAt",
    stateColumn: "thumbState" | "textState" | "hashState",
  ): Prisma.Sql {
    // Column names are from the closed unions above, never from caller input.
    const col = Prisma.raw(`"${column}"`);
    const stateCol = Prisma.raw(`"${stateColumn}"`);
    // DEDUP_STRICT_ORDER: thumb/text wait for their own row's hash job first,
    // so G2's reuse check has a chance to see a READY twin instead of racing
    // it — never applied to the hash claim itself. `<> 'PENDING'`, not
    // `= 'READY'`: a hash that failed still lets the derivative run, it only
    // loses dedup, and it keeps the flag safe to have set inconsistently
    // between worker and API (see lib/config/dedup.ts).
    const hashGate = isDedupStrictOrder() && stateColumn !== "hashState"
      ? Prisma.sql`AND "hashState" <> 'PENDING'`
      : Prisma.empty;
    return Prisma.sql`
      ${stateCol} = 'PENDING' AND ${col} IS NULL
      AND "sourceState" = 'READY'
      AND "missingSince" IS NULL
      ${hashGate}
    `;
  }

  /**
   * Claim a bounded batch of rows waiting for a derivative and mark them
   * dispatched. Returns what the feeder needs to build the jobs.
   *
   * One statement, for the same reason as {@link claimNeedsOcrBatch}: a
   * select-then-update would let two feeders (or a feeder racing its own next
   * tick) claim the same rows. `FOR UPDATE SKIP LOCKED` makes concurrent
   * claimers take disjoint batches instead of blocking on each other.
   *
   * Newest first, matching the library's default sort — the part of the library
   * the user is looking at fills in before the tail. The `id` tiebreak
   * makes that a total order: createMany stamps a whole index batch with one
   * `createdAt`, and {@link countTextBacklogAhead} has to reproduce the order.
   *
   * There is deliberately no stale-reclaim window here. A row whose stamp is set
   * but whose job died is recovered by stall detection, which marks it terminal
   * and lets the user re-run it; adding a second recovery path that silently
   * re-dispatches the same row would mean two mechanisms racing over one row.
   */
  private async claimDerivativeBatch (column: "thumbQueuedAt" | "textQueuedAt" | "hashQueuedAt", stateColumn: "thumbState" | "textState" | "hashState", limit: number) {
    if (limit <= 0) return [];
    const col = Prisma.raw(`"${column}"`);
    return this.prisma.$queryRaw<
      { id: string; userId: string; storageKey: string | null; sourcePath: string | null }[]
    >`
      UPDATE "Media"
      SET ${col} = NOW()
      WHERE "id" IN (
        SELECT "id" FROM "Media"
        WHERE ${this.derivativeEligible(column, stateColumn)}
        ORDER BY "createdAt" DESC, "id" DESC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING "id", "userId", "storageKey", "sourcePath"
    `;
  }

  /**
   * Where a row sits in the tier-1 text backlog, 1-indexed, and how many rows
   * are in it. Null unless the id is the caller's and is itself waiting.
   *
   * "Ahead" is the count of eligible rows the feeder would claim first, under
   * the same `(createdAt DESC, id DESC)` order {@link claimDerivativeBatch}
   * uses. Comparing `createdAt` alone reports every row in an index batch as
   * position 1 — createMany gives them all one timestamp.
   *
   * The count is not scoped by user because the feeder's claim isn't either — a
   * position that ignored other users' rows would under-report. Scoping is on
   * the target lookup, so someone else's id answers nothing.
   */
  async countTextBacklogAhead (userId: string, mediaId: string): Promise<{ position: number; total: number } | null> {
    const eligible = this.derivativeEligible("textQueuedAt", "textState");
    const rows = await this.prisma.$queryRaw<{ ahead: bigint; total: bigint; self: bigint; mine: bigint }[]>`
      WITH target AS (
        SELECT "createdAt" AS ts FROM "Media" WHERE "id" = ${mediaId} AND "userId" = ${userId}
      )
      SELECT
        count(*) FILTER (
          WHERE ("createdAt", "id") > ((SELECT ts FROM target), ${mediaId})
        ) AS ahead,
        count(*) FILTER (WHERE "id" = ${mediaId}) AS self,
        count(*) AS total,
        (SELECT count(*) FROM target) AS mine
      FROM "Media"
      WHERE ${eligible}
    `;
    const row = rows[0];
    // `mine` 0 would otherwise leave `ts` NULL, making every comparison NULL and
    // answering "position 1" for a row belonging to someone else. `self` 0 means
    // it is dispatched or finished: no position, only a count it isn't part of.
    if (!row || Number(row.mine) === 0 || Number(row.self) === 0) return null;
    return { position: Number(row.ahead) + 1, total: Number(row.total) };
  }

  /**
   * Claim named rows for tier-1 text extraction. Text-column twin of
   * {@link claimThumbByIds}; same guards, same "fewer rows than asked for is
   * normal" contract.
   */
  async claimTextByIds (userId: string, mediaIds: string[]) {
    if (mediaIds.length === 0) return [];
    return this.prisma.$queryRaw<
      { id: string; userId: string; storageKey: string | null; sourcePath: string | null }[]
    >`
      UPDATE "Media"
      SET "textQueuedAt" = NOW()
      WHERE "id" IN (
        SELECT "id" FROM "Media"
        WHERE "id" = ANY(${mediaIds}::text[])
          AND "userId" = ${userId}
          AND ${this.derivativeEligible("textQueuedAt", "textState")}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING "id", "userId", "storageKey", "sourcePath"
    `;
  }

  /** Claim rows waiting for a thumbnail. See {@link claimDerivativeBatch}. */
  claimThumbBatch (limit: number) {
    return this.claimDerivativeBatch("thumbQueuedAt", "thumbState", limit);
  }

  /** Claim rows waiting for tier-1 text extraction. See {@link claimDerivativeBatch}. */
  claimTextBatch (limit: number) {
    return this.claimDerivativeBatch("textQueuedAt", "textState", limit);
  }

  /** Claim rows waiting for a stream-hash job. See {@link claimDerivativeBatch}. */
  claimHashBatch (limit: number) {
    return this.claimDerivativeBatch("hashQueuedAt", "hashState", limit);
  }

  /**
   * Claim named rows for thumbnailing, ignoring backlog order entirely.
   *
   * This is the viewport path: the grid says "these forty items are on screen",
   * and they jump the queue however many tens of thousands are ahead of them.
   * Order is all it skips: the guards are {@link derivativeEligible}, the same
   * fragment {@link claimDerivativeBatch} uses, so promoting an id that is
   * already dispatched, already READY, not the caller's, or (under
   * DEDUP_STRICT_ORDER) still waiting on its own hash simply returns nothing.
   * That "returns fewer rows than asked for" case is the normal one, not an
   * error: most of a viewport is usually already done.
   *
   * Scoped by userId because unlike the feeder's own claim this one takes ids
   * from an HTTP request.
   */
  async claimThumbByIds (userId: string, mediaIds: string[]) {
    if (mediaIds.length === 0) return [];
    return this.prisma.$queryRaw<
      { id: string; userId: string; storageKey: string | null; sourcePath: string | null }[]
    >`
      UPDATE "Media"
      SET "thumbQueuedAt" = NOW()
      WHERE "id" IN (
        SELECT "id" FROM "Media"
        WHERE "id" = ANY(${mediaIds}::text[])
          AND "userId" = ${userId}
          AND ${this.derivativeEligible("thumbQueuedAt", "thumbState")}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING "id", "userId", "storageKey", "sourcePath"
    `;
  }

  /**
   * Undo a claim. Called when the enqueue that followed it threw, so the rows go
   * back to "waiting" instead of sitting dispatched-with-no-job until stall
   * detection gives up on them fifteen minutes later.
   */
  async releaseDerivativeClaim (kind: "thumb" | "text" | "hash", mediaIds: string[]): Promise<void> {
    if (mediaIds.length === 0) return;
    await this.prisma.media.updateMany({
      where: { id: { in: mediaIds } },
      data: kind === "thumb" ? { thumbQueuedAt: null } : kind === "text" ? { textQueuedAt: null } : { hashQueuedAt: null },
    });
  }

  /**
   * Per-state counts for all three derivatives, scoped to one user — the raw
   * material for the backlog strip's progress readout (see
   * services/media/derivativeProgress.ts). Redis only ever holds the working
   * set now, so these counts (not queue depth) are the real backlog.
   */
  async countDerivativeProgress (userId: string): Promise<DerivativeProgressCounts> {
    const [thumbRows, textRows, hashRows] = await Promise.all([
      this.prisma.media.groupBy({ by: ["thumbState"], where: { userId }, _count: true }),
      this.prisma.media.groupBy({ by: ["textState"], where: { userId }, _count: true }),
      this.prisma.media.groupBy({ by: ["hashState"], where: { userId }, _count: true }),
    ]);
    const thumbCount = (state: string) => thumbRows.find(r => r.thumbState === state)?._count ?? 0;
    const textCount = (state: string) => textRows.find(r => r.textState === state)?._count ?? 0;
    const hashCount = (state: string) => hashRows.find(r => r.hashState === state)?._count ?? 0;
    return {
      thumb: {
        pending: thumbCount("PENDING"), ready: thumbCount("READY"),
        failed: thumbCount("FAILED"), unsupported: thumbCount("UNSUPPORTED"),
      },
      text: {
        pending: textCount("PENDING"), ready: textCount("READY"), needsOcr: textCount("NEEDS_OCR"),
        error: textCount("ERROR"), unsupported: textCount("UNSUPPORTED"),
      },
      hash: {
        pending: hashCount("PENDING"), ready: hashCount("READY"), unsupported: hashCount("UNSUPPORTED"),
      },
    };
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

  /** Marks hashState PENDING → FAILED for a batch of media ids. Returns the number updated. */
  async markHashStalled (mediaIds: string[]): Promise<number> {
    const result = await this.prisma.media.updateMany({
      where: { id: { in: mediaIds }, hashState: "PENDING" },
      data: { hashState: "FAILED" },
    });
    return result.count;
  }

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

  /**
   * Set fileDate on already-indexed rows that still have it NULL (rows created
   * before the column existed). Only NULL columns are written — mtime is the
   * lowest-precedence date source, so an EXIF/PDF-derived value is never
   * overwritten. Used by the index worker when a scan encounters files it
   * would otherwise skip as already indexed.
   */
  async backfillFileDates (userId: string, items: { sourcePath: string; fileDate: Date }[]): Promise<void> {
    if (items.length === 0) return;
    await this.prisma.$executeRaw`
      UPDATE "Media" m
      SET "fileDate" = (v."fileDate"::timestamptz AT TIME ZONE 'UTC')
      FROM (
        SELECT unnest(${items.map(i => i.sourcePath)}::text[]) AS "sourcePath",
               unnest(${items.map(i => i.fileDate.toISOString())}::text[]) AS "fileDate"
      ) v
      WHERE m."userId" = ${userId} AND m."sourcePath" = v."sourcePath" AND m."fileDate" IS NULL
    `;
  }

  /** The Media id for an in-place item at this exact source path, or null. Used
   *  by the live watcher to resolve an `unlink` event to the row to delete, and
   *  by ingest to read back an id that the watcher may have created first. */
  async findIdBySourcePath (userId: string, sourcePath: string): Promise<string | null> {
    const row = await this.prisma.media.findFirst({
      where: { userId, sourcePath },
      select: { id: true },
    });
    return row?.id ?? null;
  }

  /**
   * The full identity of the in-place item at this exact path — what the
   * watcher's `unlink` handler needs to look for the same file having already
   * turned up somewhere else (the reverse event ordering), rather than just the
   * id it needs to tombstone.
   */
  async findIdentityBySourcePath (
    userId: string,
    sourcePath: string,
  ): Promise<(MoveCandidateRow & { sourcePath: string; missingSince: Date | null }) | null> {
    const row = await this.prisma.media.findFirst({
      where: { userId, sourcePath },
      select: {
        id: true, sourcePath: true, sizeBytes: true, missingSince: true,
        sourceMtimeMs: true, contentHash: true, titleIsUserEdited: true,
      },
    });
    if (!row?.sourcePath) return null;
    return {
      id: row.id,
      sourcePath: row.sourcePath,
      basename: path.basename(row.sourcePath),
      sizeBytes: row.sizeBytes,
      mtimeMs: row.sourceMtimeMs,
      contentHash: row.contentHash,
      titleIsUserEdited: row.titleIsUserEdited,
      missingSince: row.missingSince,
    };
  }

  /**
   * `sourcePath` sits inside directory `prefix` — shared so the two prefix
   * queries below cannot drift. Prisma's `startsWith` is unusable here: it
   * compiles to `LIKE 'E:\root\%'` leaving `\`, `%` and `_` unescaped, and
   * Postgres reads backslash as LIKE's escape character, so a Windows prefix
   * matches nothing. `starts_with()` has no pattern syntax to escape. The
   * trailing separator keeps `/a/b` off a sibling `/a/bc`; either one counts,
   * so a POSIX prefix is not handed a backslash on Windows.
   */
  private sourcePathUnder (prefix: string): Prisma.Sql {
    const withSep = /[\\/]$/.test(prefix) ? prefix : prefix + path.sep;
    return Prisma.sql`starts_with("sourcePath", ${withSep})`;
  }

  /** Media ids for in-place items whose source path sits under `prefix` (a
   *  removed directory). Used by the watcher's `unlinkDir` handler. */
  async findIdsBySourcePathPrefix (userId: string, prefix: string): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "Media"
      WHERE "userId" = ${userId} AND ${this.sourcePathUnder(prefix)}
    `;
    return rows.map(r => r.id);
  }

  /**
   * Tombstone in-place rows whose source stopped existing: keep every column
   * (tags, title, starred, bundles, reminders, text) and only stamp
   * `missingSince`, so a subsequent `add` from the other half of a move can
   * rematch and reclaim the row. Already-missing rows keep their original
   * timestamp — re-stamping would restart the grace period on every reconcile.
   * Returns how many were newly marked.
   */
  async markMissing (userId: string, ids: string[], at: Date = new Date()): Promise<number> {
    if (ids.length === 0) return 0;
    const result = await this.prisma.media.updateMany({
      where: { userId, id: { in: ids }, missingSince: null },
      data: { missingSince: at },
    });
    return result.count;
  }

  /**
   * Tombstoned rows still inside the move-detection window, as identity
   * candidates for {@link matchIdentity}. `basename` is derived here so the
   * matcher stays free of path handling.
   */
  async findMoveCandidates (userId: string, since: Date): Promise<MoveCandidateRow[]> {
    const rows = await this.prisma.media.findMany({
      where: { userId, missingSince: { gte: since }, sourcePath: { not: null } },
      select: {
        id: true, sourcePath: true, sizeBytes: true,
        sourceMtimeMs: true, contentHash: true, titleIsUserEdited: true,
      },
    });
    return rows.map(r => ({
      id: r.id,
      basename: path.basename(r.sourcePath!),
      sizeBytes: r.sizeBytes,
      mtimeMs: r.sourceMtimeMs,
      contentHash: r.contentHash,
      titleIsUserEdited: r.titleIsUserEdited,
    }));
  }

  /**
   * Live (non-missing) rows indexed within the window, as candidates for the
   * reverse event ordering — some platforms emit the move's `add` before its
   * `unlink`, so by the time we see the unlink a bare new row already exists
   * and the old row's metadata has to be transplanted onto its path.
   */
  async findRecentlyIndexed (userId: string, since: Date): Promise<RecentlyIndexedRow[]> {
    const rows = await this.prisma.media.findMany({
      where: { userId, createdAt: { gte: since }, missingSince: null, sourcePath: { not: null } },
      select: {
        id: true, sourcePath: true, filename: true, sizeBytes: true,
        sourceMtimeMs: true, contentHash: true,
      },
    });
    return rows.map(r => ({
      id: r.id,
      sourcePath: r.sourcePath!,
      filename: r.filename,
      basename: path.basename(r.sourcePath!),
      sizeBytes: r.sizeBytes,
      mtimeMs: r.sourceMtimeMs,
      contentHash: r.contentHash,
    }));
  }

  /**
   * Repoint a tombstoned row at the path its file turned up on and revive it.
   * Everything the user owns is untouched by design — this is an UPDATE, not a
   * delete-and-insert, so the id survives and existing `/media/[id]` links keep
   * working. `title` is only passed when the old one was auto-derived.
   */
  async applyMove (
    userId: string,
    id: string,
    data: { sourcePath: string; filename: string; sizeBytes: number; mtimeMs: number | null; title?: string },
  ): Promise<void> {
    await this.prisma.media.updateMany({
      where: { userId, id },
      data: {
        sourcePath: data.sourcePath,
        filename: data.filename,
        sizeBytes: data.sizeBytes,
        ...(data.mtimeMs !== null ? { sourceMtimeMs: data.mtimeMs } : {}),
        ...(data.title !== undefined ? { title: data.title } : {}),
        missingSince: null,
      },
    });
  }

  /**
   * Every in-place row whose source sits under `root` — the library's side of
   * the reconcile diff. A root is a directory, so everything below it is in
   * scope; see {@link sourcePathUnder} for why this cannot use the ORM.
   */
  async listReconcileEntries (userId: string, root: string): Promise<ReconcileEntry[]> {
    const rows = await this.prisma.$queryRaw<Array<{
      id: string; sourcePath: string; mimeType: string; storageKey: string | null;
      sizeBytes: number; sourceMtimeMs: number | null;
      fileDate: Date | null; missingSince: Date | null;
    }>>`
      SELECT "id", "sourcePath", "mimeType", "storageKey", "sizeBytes",
             "sourceMtimeMs", "fileDate", "missingSince"
      FROM "Media"
      WHERE "userId" = ${userId} AND ${this.sourcePathUnder(root)}
    `;
    return rows.map(r => ({
      id: r.id,
      sourcePath: r.sourcePath,
      mimeType: r.mimeType,
      storageKey: r.storageKey,
      sizeBytes: r.sizeBytes,
      mtimeMs: r.sourceMtimeMs,
      fileDate: r.fileDate,
      missingSince: r.missingSince,
    }));
  }

  /**
   * The bytes at `sourcePath` changed under us. Record the new size/mtime and
   * invalidate every artifact derived from the old bytes, so the workers rebuild
   * them: `contentHash` above all, since a stale hash makes dedup claim two
   * different files are the same.
   *
   * `resetThumb`/`resetText` are passed rather than assumed — resetting a state
   * to PENDING for work that will never be enqueued (an unrenderable type, a
   * file with no text layer) strands the row at PENDING forever and trips stall
   * detection. The caller enqueues and resets from the same plan.
   */
  async applySourceChanged (
    userId: string,
    id: string,
    data: {
      sizeBytes: number;
      mtimeMs: number | null;
      resetThumb: boolean;
      resetText: boolean;
      /** Only for rows the thumb worker won't rehash inline (non-renderable or
       *  too-large) — a renderable row stays UNSUPPORTED and gets its hash back
       *  as a side effect of resetThumb's re-render, no separate job needed. */
      resetHash: boolean;
      /** Only set when the old fileDate was still the untouched mtime — never
       *  clobbers an EXIF/PDF date the thumb worker extracted. */
      fileDate?: Date;
    },
  ): Promise<void> {
    await this.prisma.media.updateMany({
      where: { userId, id },
      data: {
        sizeBytes: data.sizeBytes,
        ...(data.mtimeMs !== null ? { sourceMtimeMs: data.mtimeMs } : {}),
        ...(data.fileDate !== undefined ? { fileDate: data.fileDate } : {}),
        missingSince: null,
        contentHash: null,
        // Back to PENDING with the stamp cleared: reconcile does not enqueue
        // anything itself, so the feeder has to be able to see these again.
        // Leaving the stamp set would strand the row — never re-dispatched, and
        // marked FAILED by stall detection fifteen minutes later.
        ...(data.resetThumb ? { thumbnailKey: null, thumbState: "PENDING" as const, thumbError: null, thumbQueuedAt: null } : {}),
        ...(data.resetText ? { textState: "PENDING" as const, textQueuedAt: null } : {}),
        ...(data.resetHash ? { hashState: "PENDING" as const, hashQueuedAt: null } : {}),
      },
    });
  }

  /**
   * Fill in source metadata a row never had, without touching anything derived
   * from its bytes.
   *
   * Deliberately not {@link applySourceChanged}: nothing changed on disk here.
   * The file matched what we had recorded — it is the *record* that was
   * incomplete, because the row predates the `sourceMtimeMs` column or the
   * `fileDate` one. Routing this through `applySourceChanged` would null
   * `contentHash` (correct only when the bytes really changed, where a re-hash
   * always follows) and quietly lose the user their duplicate detection.
   *
   * `fileDate` is guarded on `null` in the WHERE, mirroring `backfillFileDates`,
   * so a date the thumb worker upgraded from EXIF/PDF metadata is never
   * overwritten by a coarser mtime — even if the caller passes one.
   */
  async healSourceMetadata (
    userId: string,
    id: string,
    data: { mtimeMs?: number; fileDate?: Date },
  ): Promise<void> {
    if (data.mtimeMs === undefined && data.fileDate === undefined) return;
    if (data.mtimeMs !== undefined) {
      await this.prisma.media.updateMany({
        where: { userId, id },
        data: { sourceMtimeMs: data.mtimeMs },
      });
    }
    if (data.fileDate !== undefined) {
      await this.prisma.media.updateMany({
        where: { userId, id, fileDate: null },
        data: { fileDate: data.fileDate },
      });
    }
  }

  /** Clear the tombstone on a row whose file came back at the same path. */
  async clearMissing (userId: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.prisma.media.updateMany({
      where: { userId, id: { in: ids } },
      data: { missingSince: null },
    });
  }

  /**
   * Rows tombstoned before `cutoff` — the sweeper's input. These have outlived
   * the grace period without their file reappearing, so they are genuine
   * deletions rather than moves and can finally be removed for real.
   */
  async findMissingBefore (userId: string, cutoff: Date, limit: number): Promise<string[]> {
    const rows = await this.prisma.media.findMany({
      where: { userId, missingSince: { not: null, lt: cutoff } },
      select: { id: true },
      take: limit,
    });
    return rows.map(r => r.id);
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

  /** Mark rows the thumb worker will hash inline — "no job needed", not "can't
   *  be hashed" (see the hashState column comment in schema.prisma). Guards on
   *  PENDING like the sibling `mark*Unsupported` methods. */
  async markHashUnsupported (mediaIds: string[]): Promise<void> {
    if (mediaIds.length === 0) return;
    await this.prisma.media.updateMany({
      where: { id: { in: mediaIds }, hashState: "PENDING" },
      data: { hashState: "UNSUPPORTED" },
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
   * Every tag under the given namespaces, ignoring the paged tag list entirely.
   *
   * The sidebar's facet groups derive from these. Slicing them out of
   * {@link listTopTags}' `count desc` page instead means a `year:2019` with four
   * items sits hundreds of rows down and the whole Year group is missing until
   * the tag list has been scrolled that far.
   *
   * Capped so a pathological `folder:` vocabulary can't turn the sidebar into a
   * table scan. Prisma's `startsWith` escaping problem (see `sourcePathUnder`)
   * doesn't apply — these prefixes are our own constants, not user input.
   */
  async listFacetTags (userId: string, namespaces: string[]) {
    if (namespaces.length === 0) return [];
    const rows = await this.prisma.tag.findMany({
      where: {
        userId,
        OR: namespaces.map(ns => ({ name: { startsWith: `${ns}:` } })),
      },
      orderBy: [{ count: 'desc' }, { name: 'asc' }],
      take: 500,
      select: { name: true, count: true, color: true, origin: true },
    });
    return rows.map(r => ({ tag: r.name, count: r.count, color: r.color ?? null, origin: r.origin }));
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
      // Rows that already carry BOTH names would get a duplicate from
      // array_replace, so drop the old name from those first.
      const merged = await tx.$executeRaw`
        UPDATE "Media"
        SET "tags" = array_remove("tags", ${oldName})
        WHERE "userId" = ${userId} AND ${oldName} = ANY("tags") AND ${newName} = ANY("tags")
      `;
      const replaced = await tx.$executeRaw`
        UPDATE "Media"
        SET "tags" = array_replace("tags", ${oldName}, ${newName})
        WHERE "userId" = ${userId} AND ${oldName} = ANY("tags")
      `;
      // Rename the Tag row. If newName already exists, merge then delete old.
      const existing = await tx.tag.findUnique({ where: { userId_name: { userId, name: newName } } });
      const oldRow   = await tx.tag.findUnique({ where: { userId_name: { userId, name: oldName } } });
      if (existing && oldRow) {
        await tx.tag.delete({ where: { userId_name: { userId, name: oldName } } });
      } else if (oldRow) {
        await tx.tag.update({
          where: { userId_name: { userId, name: oldName } },
          data: { name: newName },
        });
      }
      // Recount from committed rows — summing the two counts overstates when any
      // item carried both tags.
      const [{ count }] = await tx.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*) AS count FROM "Media"
        WHERE "userId" = ${userId} AND ${newName} = ANY("tags")
      `;
      await tx.tag.updateMany({
        where: { userId, name: newName },
        data: { count: Number(count) },
      });
      return merged + replaced;
    });
  }

  /** Toggle the star on a media item (mirrors bundleRepository.toggleStar).
   *  Returns the new starred state, or null when the item isn't the user's. */
  async toggleStar (id: string, userId: string): Promise<boolean | null> {
    const media = await this.prisma.media.findFirst({
      where: { id, userId },
      select: { starred: true },
    });
    if (!media) return null;

    const next = !media.starred;
    await this.prisma.media.update({
      where: { id },
      data: { starred: next, starredAt: next ? new Date() : null },
    });
    return next;
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
