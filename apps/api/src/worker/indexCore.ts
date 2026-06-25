import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { MediaRepository } from "../repositories/mediaRepository.js";
import type { Queue } from "bullmq";
import type { ThumbJob } from "../queues/enqueueThumbnail.js";
import type { OcrJobData } from "../services/ocrProcessingService.js";
import { enqueueThumbBulk } from "../queues/enqueueThumbnail.js";
import { enqueueOcrBulk } from "../queues/enqueueOcr.js";
import { mimeFromExtension } from "../lib/media/mimeFromExtension.js";
import { extOf } from "../lib/media/extensions.js";
import { normalizeMimeType, buildMimeTypeTag } from "../lib/tags/mimeTypeTag.js";
import { normalizeTags } from "../lib/tags/normalizeTags.js";
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
};

export type DiscoveredFile = { absPath: string; name: string; size: number };

/** True if a file's extension is in the (already-normalized) blacklist. */
export function isBlacklisted (name: string, blacklist: string[]): boolean {
  if (blacklist.length === 0) return false;
  return blacklist.includes(extOf(name));
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

  const existing = await deps.mediaRepository.findExistingSourcePaths(
    userId,
    files.map(f => f.absPath),
  );
  const fresh = files.filter(f => !existing.has(f.absPath));
  if (fresh.length === 0) return { indexed: 0, skipped: files.length };

  const rows: Prisma.MediaCreateManyInput[] = [];
  // Indexed files are only ever auto-tagged with their MIME tag.
  const autoTagsByItem: string[][] = [];
  const thumbItems: { mediaId: string; userId: string; storageKey: string; sourcePath: string; allowedRoots: string[] }[] = [];
  const ocrItems: { mediaId: string; userId: string; storageKey: string; allowedRoots: string[] }[] = [];
  const textUnsupportedIds: string[] = [];
  const thumbUnsupportedIds: string[] = [];
  const thumbTooLargeIds: string[] = [];

  for (const file of fresh) {
    const id = randomUUID();
    const mimeType = normalizeMimeType(mimeFromExtension(file.name), file.name);
    const mimeTag = normalizeTags(buildMimeTypeTag(mimeType, file.name))[0];
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
      tags: mimeTag ? [mimeTag] : [],
      sourceState: "READY", // the original already exists on disk
      thumbState: "PENDING",
      textState: "PENDING",
    });
    autoTagsByItem.push(mimeTag ? [mimeTag] : []);

    // Thumbnail: supported type AND small enough to load into memory. Too-large
    // files are marked UNSUPPORTED rather than enqueued — the worker can't buffer a
    // >2 GiB source, so the job would only fail.
    if (!thumbnailSupported(mimeType)) thumbUnsupportedIds.push(id);
    else if (exceedsThumbnailSize(file.size)) thumbTooLargeIds.push(id);
    else thumbItems.push({ mediaId: id, userId, storageKey, sourcePath: file.absPath, allowedRoots });
    if (ocrSupported(mimeType)) ocrItems.push({ mediaId: id, userId, storageKey, allowedRoots });
    else textUnsupportedIds.push(id);
  }

  // skipDuplicates tolerates a race on the (userId, sourcePath) unique index.
  await deps.mediaRepository.createBatch(rows, { skipDuplicates: true, autoTagsByItem });

  await Promise.all([
    thumbItems.length > 0 ? enqueueThumbBulk(deps.thumbQueue, thumbItems) : Promise.resolve(),
    ocrItems.length > 0 ? enqueueOcrBulk(deps.ocrQueue, ocrItems) : Promise.resolve(),
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
