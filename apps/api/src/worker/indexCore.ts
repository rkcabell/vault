import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { MediaRepository } from "../repositories/mediaRepository.js";
import { mimeFromExtension } from "../lib/media/mimeFromExtension.js";
import { extOf } from "../lib/media/extensions.js";
import { normalizeMimeType } from "../lib/tags/mimeTypeTag.js";
import { evaluateRules, type IngestSource, type TagRuleInput } from "../lib/tags/rules/evaluateRules.js";
import { canonicalizeAbsPath } from "../lib/media/indexRoots.js";
import { deriveTitle } from "../lib/media/deriveTitle.js";
import { ocrSupported, thumbnailSupported, exceedsThumbnailSize } from "../lib/media/processingSupport.js";
import { isDedupStrictOrder } from "../lib/config/dedup.js";

// Re-exported: callers import this from here as well as from processingSupport.
export { ocrSupported } from "../lib/media/processingSupport.js";

/** Dependencies shared by the one-shot scan worker and the live watcher. */
export type IndexCoreDeps = {
  mediaRepository: MediaRepository;
  /** The user's enabled Tag Organizer rules (see lib/tags/rules/evaluateRules). */
  listTagRules: (userId: string) => Promise<TagRuleInput[]>;
  /** The user's `autoTagOnIngest` preference. Absent, tagging is enabled. */
  getAutoTagOnIngest?: (userId: string) => Promise<boolean>;
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
  /** Enqueue tier-1 text extraction (`text_queue`). Never Tesseract — see
   *  enqueueText.ts for why the two tiers are separate queues. */
  text: boolean;
  /** Type the thumbnailer cannot render at all. */
  thumbUnsupported: boolean;
  /** Renderable type, but too big to buffer. */
  thumbTooLarge: boolean;
};

/**
 * Decides what derived work a file needs, from its type and size alone. The same
 * plan serves first-time indexing and the reconcile sweep's changed-bytes path,
 * so a re-derivation queues what a first index would have.
 *
 * The hash fallback matters: the thumbnail worker hashes everything it renders,
 * so anything that skips a thumbnail job needs an explicit hash job. Without one
 * its `contentHash` stays empty and dedup never sees it.
 *
 * `hashAll` forces an explicit hash job even for a renderable row, so a claim
 * gated on `hashState <> 'PENDING'` waits for the hash rather than racing it. It
 * costs a second read of every renderable file.
 */
export function planDerivations (mimeType: string, sizeBytes: number, opts?: { hashAll?: boolean }): DerivationPlan {
  const renderable = thumbnailSupported(mimeType);
  const tooLarge = renderable && exceedsThumbnailSize(sizeBytes);
  return {
    thumb: renderable && !tooLarge,
    hash: opts?.hashAll ? true : (!renderable || tooLarge),
    text: ocrSupported(mimeType),
    thumbUnsupported: !renderable,
    thumbTooLarge: tooLarge,
  };
}

/**
 * Indexes a set of discovered files: skips paths that already have a row, creates
 * one for each that does not, and marks the rows no derivative can be made for.
 * Returns how many were newly indexed, and how many were skipped.
 *
 * It queues no thumbnail or text work. Rows are written at PENDING, and the
 * derivative feeder takes them from there.
 *
 * The bulk scan, the live watcher and ingest all come through here, so a row
 * looks the same whichever found the file.
 */
export async function indexFiles (
  deps: IndexCoreDeps,
  userId: string,
  files: DiscoveredFile[],
  allowedRoots: string[],
  /** `source:` axis for the rows created here. Ingest passes "upload" so a file
   *  sent over HTTP stays distinguishable from one found by a scan. */
  opts?: { ingestSource?: IngestSource },
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

  // A row indexed before the fileDate column existed has none, and a re-scan
  // skips it otherwise. The walk holds a fresh stat, so it fills them in here.
  // Only a null column is written: a modified time must not overwrite a date
  // read from the file itself.
  const backfillItems = files
    .filter(f => existing.has(f.absPath) && f.mtimeMs && f.mtimeMs > 0)
    .map(f => ({ sourcePath: f.absPath, fileDate: new Date(f.mtimeMs!) }));
  if (backfillItems.length > 0) {
    await deps.mediaRepository.backfillFileDates(userId, backfillItems);
  }

  const fresh = files.filter(f => !existing.has(f.absPath));
  if (fresh.length === 0) return { indexed: 0, skipped: files.length };

  const rows: Prisma.MediaCreateManyInput[] = [];
  // An indexed file carries only the tags the rules produce. Nobody types
  // anything here, so with autoTagOnIngest off a row arrives with no tags at
  // all, not even the `source:` axis.
  const autoTag = (await deps.getAutoTagOnIngest?.(userId)) ?? true;
  const rules = autoTag ? await deps.listTagRules(userId) : [];
  const autoTagsByItem: string[][] = [];
  const textUnsupportedIds: string[] = [];
  const thumbUnsupportedIds: string[] = [];
  const thumbTooLargeIds: string[] = [];
  const hashAll = isDedupStrictOrder();

  for (const file of fresh) {
    const id = randomUUID();
    const mimeType = normalizeMimeType(mimeFromExtension(file.name), file.name);
    // The modified time is the best date known here. The thumbnail worker
    // replaces it with the date inside the file once it reads the metadata.
    const fileDate = file.mtimeMs && file.mtimeMs > 0 ? new Date(file.mtimeMs) : null;
    const autoTags = autoTag
      ? evaluateRules(rules, {
          filename: file.name,
          mimeType,
          sizeBytes: file.size,
          sourcePath: file.absPath,
          indexRoots: allowedRoots,
          fileDate,
          ingest: opts?.ingestSource ?? "index",
        })
      : [];
    // Nothing is queued here: rows are written straight at the state the feeder
    // claims from. What matters is marking the rows that must never be claimed.
    // A type that can never render, left at PENDING, would be fed again and
    // again into a job that can only fail.
    const plan = planDerivations(mimeType, file.size, { hashAll });
    rows.push({
      id,
      userId,
      // An item indexed in place reads from sourcePath, never from managed
      // storage. Written out rather than left to Prisma's omit-means-null.
      storageKey: null,
      sourcePath: file.absPath,
      filename: file.name,
      mimeType,
      sizeBytes: file.size,
      title: deriveTitle(file.name),
      tags: autoTags,
      fileDate,
      // Kept apart from fileDate, which the thumbnail worker later replaces with
      // the date inside the file. Move detection needs the untouched one.
      sourceMtimeMs: file.mtimeMs && file.mtimeMs > 0 ? file.mtimeMs : null,
      sourceState: "READY", // the original already exists on disk
      thumbState: "PENDING",
      textState: "PENDING",
      // UNSUPPORTED means no job is needed: the thumbnail worker hashes a
      // renderable row while rendering it.
      hashState: plan.hash ? "PENDING" : "UNSUPPORTED",
    });
    autoTagsByItem.push(autoTags);

    if (plan.thumbUnsupported) thumbUnsupportedIds.push(id);
    if (plan.thumbTooLarge) thumbTooLargeIds.push(id);
    if (!plan.text) textUnsupportedIds.push(id);
  }

  // skipDuplicates tolerates a race on the (userId, sourcePath) unique index.
  await deps.mediaRepository.createBatch(rows, { skipDuplicates: true, autoTagsByItem });

  // Open library views learn of the new rows from this. The client debounces
  // its refetch, so one event per batch is enough even for a large walk.
  deps.publishJobUpdate?.({ userId, mediaId: "*", field: "mediaCreated", value: String(rows.length) });

  await Promise.all([
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
