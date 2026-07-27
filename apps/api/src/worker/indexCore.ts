import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { MediaRepository } from "../repositories/mediaRepository.js";
import type { Queue } from "bullmq";
import type { ThumbJob } from "../queues/enqueueThumbnail.js";
import type { OcrJobData } from "../services/ocrProcessingService.js";
import { enqueueThumbBulk } from "../queues/enqueueThumbnail.js";
import { enqueueOcrBulk } from "../queues/enqueueOcr.js";
import { enqueueHashBulk, type EnqueueHashItem, type HashJobData } from "../queues/enqueueHash.js";
import { mimeFromExtension } from "../lib/media/mimeFromExtension.js";
import { extOf } from "../lib/media/extensions.js";
import { normalizeMimeType } from "../lib/tags/mimeTypeTag.js";
import { evaluateRules, type TagRuleInput } from "../lib/tags/rules/evaluateRules.js";
import { canonicalizeAbsPath } from "../lib/media/indexRoots.js";
import { deriveTitle } from "../lib/media/deriveTitle.js";
import { ocrSupported, thumbnailSupported, exceedsThumbnailSize } from "../lib/media/processingSupport.js";

// Re-exported for existing consumers that imported it from here before it moved
// to the shared processingSupport module.
export { ocrSupported } from "../lib/media/processingSupport.js";

/** Dependencies shared by the one-shot scan worker and the live watcher. */
export type IndexCoreDeps = {
  mediaRepository: MediaRepository;
  thumbQueue: Queue<ThumbJob>;
  ocrQueue: Queue<OcrJobData>;
  /** Stream-hash queue for items the thumb worker won't hash (non-thumbnailable
   *  or too-large) — keeps contentHash coverage complete for dedup. Optional so
   *  existing tests/fakes keep working; absent = those items stay unhashed
   *  until a dedup scan. */
  hashQueue?: Queue<HashJobData>;
  /** The user's enabled Tag Organizer rules (see lib/tags/rules/evaluateRules). */
  listTagRules: (userId: string) => Promise<TagRuleInput[]>;
  /** Publishes a media event so open library views pick up newly indexed items. */
  publishJobUpdate?: (update: { userId: string; mediaId: string; field: string; value: string }) => void;
};

export type DiscoveredFile = {
  absPath: string;
  name: string;
  size: number;
  /** File mtime when the discoverer had a stat in hand — feeds FILE_DATE rules. */
  mtimeMs?: number;
};

/** True if a file's extension is in the (already-normalized) blacklist. */
export function isBlacklisted (name: string, blacklist: string[]): boolean {
  if (blacklist.length === 0) return false;
  return blacklist.includes(extOf(name));
}

/** Which derived artifacts a file's type and size call for. */
export type DerivationPlan = {
  /** Enqueue a thumbnail job (which hashes the source as a side effect). */
  thumb: boolean;
  /** Enqueue a stream-hash job instead — the thumb job won't run to do it. */
  hash: boolean;
  /** Enqueue OCR / text extraction. */
  ocr: boolean;
  /** Type the thumbnailer cannot render at all. */
  thumbUnsupported: boolean;
  /** Renderable type, but too big to buffer. */
  thumbTooLarge: boolean;
};

/**
 * Decide what work a file needs, from its type and size alone.
 *
 * Shared by initial indexing and by the reconcile sweep's "bytes changed under
 * us" path so a re-derivation queues exactly what a first index would have. The
 * hash fallback matters: the thumb worker hashes everything it processes, so
 * anything that skips the thumb job needs an explicit hash job or its
 * `contentHash` — and therefore dedup — silently stays empty.
 */
export function planDerivations (mimeType: string, sizeBytes: number): DerivationPlan {
  const renderable = thumbnailSupported(mimeType);
  const tooLarge = renderable && exceedsThumbnailSize(sizeBytes);
  return {
    thumb: renderable && !tooLarge,
    hash: !renderable || tooLarge,
    ocr: ocrSupported(mimeType),
    thumbUnsupported: !renderable,
    thumbTooLarge: tooLarge,
  };
}

/**
 * Index a set of discovered files: skip already-indexed paths, create Media rows
 * that reference each file in place (sourcePath set, sourceState READY), and
 * enqueue thumbnail + OCR work. Returns how many were newly indexed vs skipped.
 *
 * Shared by the bulk scan (batches of {@link DiscoveredFile}) and the live
 * watcher (single-element batches), so both produce identical rows + jobs.
 */
export async function indexFiles (
  deps: IndexCoreDeps,
  userId: string,
  files: DiscoveredFile[],
  allowedRoots: string[],
): Promise<{ indexed: number; skipped: number }> {
  if (files.length === 0) return { indexed: 0, skipped: 0 };

  // Canonicalize before dedup/store: the scan worker and the live watcher can
  // report the same file with different separators or drive-letter case on
  // Windows, and the (userId, sourcePath) unique index compares byte-exact.
  files = files.map(f => ({ ...f, absPath: canonicalizeAbsPath(f.absPath) }));

  const existing = await deps.mediaRepository.findExistingSourcePaths(
    userId,
    files.map(f => f.absPath),
  );

  // Rows indexed before the fileDate column existed have it NULL and are
  // otherwise skipped forever by re-scans. The walk has a fresh stat in hand,
  // so heal them here; only NULL columns are written (mtime is the
  // lowest-precedence date source and must not clobber an EXIF/PDF date).
  const backfillItems = files
    .filter(f => existing.has(f.absPath) && f.mtimeMs && f.mtimeMs > 0)
    .map(f => ({ sourcePath: f.absPath, fileDate: new Date(f.mtimeMs!) }));
  if (backfillItems.length > 0) {
    await deps.mediaRepository.backfillFileDates(userId, backfillItems);
  }

  const fresh = files.filter(f => !existing.has(f.absPath));
  if (fresh.length === 0) return { indexed: 0, skipped: files.length };

  const rows: Prisma.MediaCreateManyInput[] = [];
  // Indexed files carry only rule-evaluated auto tags (type:, folder:, year:, …);
  // there is no user input at this ingest site.
  const rules = await deps.listTagRules(userId);
  const autoTagsByItem: string[][] = [];
  const thumbItems: { mediaId: string; userId: string; storageKey: string; sourcePath: string; allowedRoots: string[] }[] = [];
  const ocrItems: { mediaId: string; userId: string; storageKey: string; allowedRoots: string[] }[] = [];
  const hashItems: EnqueueHashItem[] = [];
  const textUnsupportedIds: string[] = [];
  const thumbUnsupportedIds: string[] = [];
  const thumbTooLargeIds: string[] = [];

  for (const file of fresh) {
    const id = randomUUID();
    const mimeType = normalizeMimeType(mimeFromExtension(file.name), file.name);
    // mtime is the best date known at index time; the thumb worker upgrades it
    // to the embedded EXIF/PDF date after metadata extraction.
    const fileDate = file.mtimeMs && file.mtimeMs > 0 ? new Date(file.mtimeMs) : null;
    const autoTags = evaluateRules(rules, {
      filename: file.name,
      mimeType,
      sizeBytes: file.size,
      sourcePath: file.absPath,
      indexRoots: allowedRoots,
      fileDate,
      ingest: "index",
    });
    // Sentinel storageKey: in-place items never store source bytes here (source
    // is read from sourcePath), but the column is NOT NULL and a real-looking
    // key degrades to a clean 404 instead of a 500 if ever read unbranched.
    const storageKey = `external/${userId}/${id}/${file.name}`;

    rows.push({
      id,
      userId,
      storageKey,
      sourcePath: file.absPath,
      filename: file.name,
      mimeType,
      sizeBytes: file.size,
      title: deriveTitle(file.name),
      tags: autoTags,
      fileDate,
      // Kept separate from fileDate, which the thumb worker upgrades to the
      // embedded EXIF/PDF date. Move detection needs the untouched mtime.
      sourceMtimeMs: file.mtimeMs && file.mtimeMs > 0 ? file.mtimeMs : null,
      sourceState: "READY", // the original already exists on disk
      thumbState: "PENDING",
      textState: "PENDING",
    });
    autoTagsByItem.push(autoTags);

    // Thumbnail: supported type AND small enough to load into memory. Too-large
    // files are marked UNSUPPORTED rather than enqueued — the worker can't buffer a
    // >2 GiB source, so the job would only fail.
    const plan = planDerivations(mimeType, file.size);
    if (plan.thumb) thumbItems.push({ mediaId: id, userId, storageKey, sourcePath: file.absPath, allowedRoots });
    if (plan.hash) hashItems.push({ mediaId: id, userId, storageKey, sourcePath: file.absPath, allowedRoots });
    if (plan.thumbUnsupported) thumbUnsupportedIds.push(id);
    if (plan.thumbTooLarge) thumbTooLargeIds.push(id);
    if (plan.ocr) ocrItems.push({ mediaId: id, userId, storageKey, allowedRoots });
    else textUnsupportedIds.push(id);
  }

  // skipDuplicates tolerates a race on the (userId, sourcePath) unique index.
  await deps.mediaRepository.createBatch(rows, { skipDuplicates: true, autoTagsByItem });

  // New rows exist — tell open library views (the client debounces its refetch,
  // so per-batch granularity is fine even for large walks).
  deps.publishJobUpdate?.({ userId, mediaId: "*", field: "mediaCreated", value: String(rows.length) });

  await Promise.all([
    thumbItems.length > 0 ? enqueueThumbBulk(deps.thumbQueue, thumbItems) : Promise.resolve(),
    ocrItems.length > 0 ? enqueueOcrBulk(deps.ocrQueue, ocrItems) : Promise.resolve(),
    hashItems.length > 0 && deps.hashQueue ? enqueueHashBulk(deps.hashQueue, hashItems) : Promise.resolve(),
    textUnsupportedIds.length > 0
      ? deps.mediaRepository.markTextUnsupported(textUnsupportedIds)
      : Promise.resolve(),
    thumbUnsupportedIds.length > 0
      ? deps.mediaRepository.markThumbUnsupported(thumbUnsupportedIds)
      : Promise.resolve(),
    thumbTooLargeIds.length > 0
      ? deps.mediaRepository.markThumbTooLarge(thumbTooLargeIds)
      : Promise.resolve(),
  ]);

  return { indexed: fresh.length, skipped: files.length - fresh.length };
}
