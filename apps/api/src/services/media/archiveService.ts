import crypto from "node:crypto";
import path from "node:path";
import type { Writable } from "node:stream";
import archiver from "archiver";
import type { Queue } from "bullmq";
import type { MediaRepository } from "../../repositories/mediaRepository.js";
import type { BundleRepository } from "../../repositories/bundleRepository.js";
import type { StorageAdapter } from "../../adapters/storage/types.js";
import { openSourceStream } from "../../adapters/storage/openSource.js";
import { enqueueUnpack, type UnpackJob } from "../../queues/enqueueUnpack.js";
import { makeStorageKey } from "../../lib/media/keys.js";
import { extractArchive, isCoverCandidate } from "../archive/extractArchive.js";
import { normalizeTag } from "../../lib/tags/normalizeTags.js";
import { evaluateRules, type TagRuleInput } from "../../lib/tags/rules/evaluateRules.js";
import { ARCHIVE_MIME_TYPES } from "../../lib/media/archiveTypes.js";
import { ocrSupported, thumbnailSupported } from "../../lib/media/processingSupport.js";
import { planDerivations } from "../../worker/indexCore.js";

/**
 * Builds zip downloads, and unpacks an archive into a bundle of new items. An
 * unpacked entry is written to managed storage, never back into the folder the
 * archive came from.
 */

const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/heic": ".heic",
  "image/heif": ".heif",
  "image/tiff": ".tiff",
  "image/bmp": ".bmp",
  "image/svg+xml": ".svg",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/x-msvideo": ".avi",
  "video/webm": ".webm",
  "video/x-matroska": ".mkv",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
  "text/html": ".html",
  "text/csv": ".csv",
  "application/json": ".json",
  "application/zip": ".zip",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.ms-excel": ".xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.ms-powerpoint": ".ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
};

/**
 * Coerces an arbitrary string into a valid tag, stripping the characters
 * `normalizeTag` rejects. Returns null when nothing usable is left.
 */
function coerceTag(name: string): string | null {
  const prepped = name
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  try {
    return normalizeTag(prepped);
  } catch {
    return null;
  }
}

function sanitizeTitle (title: string): string {
  const cleaned = title.replace(/[/\\:*?"<>|]/g, "").trim().slice(0, 100);
  return cleaned || "";
}

function extFromFilename (filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(dot) : "";
}

/** Returns a name for `item` inside the zip, numbered when `usedNames` has it already. */
function buildFilename (
  item: { id: string; title: string; mimeType: string | null; filename: string },
  usedNames: Set<string>,
): string {
  const ext =
    (item.mimeType && MIME_TO_EXT[item.mimeType]) ??
    extFromFilename(item.filename) ??
    "";
  const base = sanitizeTitle(item.title) || item.id;
  let name = `${base}${ext}`;
  if (!usedNames.has(name)) {
    usedNames.add(name);
    return name;
  }
  let counter = 2;
  while (usedNames.has(name)) {
    name = `${base}_${counter}${ext}`;
    counter++;
  }
  usedNames.add(name);
  return name;
}

type ArchiveDeps = {
  repository: MediaRepository;
  bundleRepository: BundleRepository;
  storage: StorageAdapter;
  bucket: string;
  /** Absent in the unpack worker, which reads this queue rather than adding to it. */
  unpackQueue?: Queue<UnpackJob>;
  logger: { warn: (obj: unknown, msg: string) => void };
  /** The user's enabled Tag Organizer rules, applied to unpacked entries. */
  listTagRules?: (userId: string) => Promise<TagRuleInput[]>;
  /** The user's `autoTagOnIngest` preference. Absent, tagging is enabled. */
  getAutoTagOnIngest?: (userId: string) => Promise<boolean>;
  /** Publishes a media event, so open library views show the new items. */
  publishJobUpdate?: (update: { userId: string; mediaId: string; field: string; value: string }) => void;
};

export function createArchiveService (deps: ArchiveDeps) {
  const getBulkDownloadItems = async (userId: string, ids: string[]) => {
    return deps.repository.findBulkDownloadItems(userId, ids);
  };

  const streamBulkArchive = async (
    items: { id: string; storageKey: string | null; sourcePath?: string | null; title: string; mimeType: string | null; filename: string }[],
    dest: Writable,
    logger: { error: (obj: unknown, msg: string) => void },
    allowedRoots: string[],
  ) => {
    const archive = archiver("zip", { zlib: { level: 0 } });

    archive.on("error", (err) => {
      logger.error(err, "bulk-download archive error");
      if (!dest.writableEnded) dest.destroy(err);
    });

    archive.pipe(dest);

    const usedNames = new Set<string>();
    for (const item of items) {
      const result = await openSourceStream({
        storage: deps.storage,
        bucket: deps.bucket,
        storageKey: item.storageKey,
        sourcePath: item.sourcePath,
        allowedRoots,
      });
      if (!result) continue;
      const filename = buildFilename(item, usedNames);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      archive.append(result.body as any, { name: filename });
    }

    await archive.finalize();
  };

  const unpackArchive = async (
    userId: string,
    mediaId: string,
    allowedRoots: string[] = [],
  ): Promise<{ bundleId: string } | null | "already-linked" | "not-archive"> => {
    const media = await deps.repository.findDetail(userId, mediaId);
    if (!media) return null;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((media as any).linkedBundleId) return "already-linked";

    if (!ARCHIVE_MIME_TYPES.has(media.mimeType)) return "not-archive";

    const sourceObject = await openSourceStream({
      storage: deps.storage,
      bucket: deps.bucket,
      storageKey: media.storageKey,
      sourcePath: media.sourcePath,
      allowedRoots,
    });
    if (!sourceObject) return null;

    const baseName = path.basename(media.title ?? media.filename, path.extname(media.filename));
    const bundleName = baseName || media.title || "Unpacked Archive";

    const bundle = await deps.bundleRepository.createBundle(userId, bundleName);
    const bundleId = bundle.id;

    // One rules fetch covers every extracted entry.
    const autoTag = (await deps.getAutoTagOnIngest?.(userId)) ?? true;
    const rules = autoTag ? ((await deps.listTagRules?.(userId)) ?? []) : [];

    const createdIds: string[] = [];
    const thumbUnsupportedIds: string[] = [];
    const textUnsupportedIds: string[] = [];
    let coverCandidateId: string | null = null;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bodyStream = sourceObject.body as any;

    for await (const entry of extractArchive(bodyStream, media.mimeType)) {
      const newId = crypto.randomUUID();
      const filename = path.basename(entry.path);
      if (!filename) continue;

      const storageKey = makeStorageKey(userId, newId, filename);

      await deps.storage.putObject({
        bucket: deps.bucket,
        key: storageKey,
        body: entry.stream,
        contentType: entry.mimeType,
        contentLength: entry.size,
      });

      const title = path.basename(filename, path.extname(filename)) || filename;

      // `autoTagOnIngest` gates the rule tags only. The bundle-name tag is
      // always applied.
      const ruleTags = autoTag
        ? evaluateRules(rules, {
            filename,
            mimeType: entry.mimeType,
            sizeBytes: entry.size ?? 0,
            ingest: "unpacked",
          })
        : [];
      const extractedTags = Array.from(
        new Set([coerceTag(bundleName), ...ruleTags].filter((t): t is string => t !== null)),
      );
      // `planDerivations` is the same rule `indexFiles` applies.
      const hashState = planDerivations(entry.mimeType, entry.size ?? 0).hash ? "PENDING" : "UNSUPPORTED";
      await deps.repository.createMedia(
        {
          id: newId,
          userId,
          storageKey,
          filename,
          mimeType: entry.mimeType,
          sizeBytes: entry.size ?? 0,
          title,
          tags: extractedTags,
          sourceState: "READY",
          thumbState: "PENDING",
          textState: "PENDING",
          hashState,
          isExtractedFromArchive: true,
          sourceArchiveId: mediaId,
        },
        { autoTags: extractedTags },
      );

      createdIds.push(newId);
      if (!thumbnailSupported(entry.mimeType)) thumbUnsupportedIds.push(newId);
      if (!ocrSupported(entry.mimeType)) textUnsupportedIds.push(newId);

      if (!coverCandidateId && isCoverCandidate(entry.mimeType)) {
        coverCandidateId = newId;
      }
    }

    if (createdIds.length === 0) {
      await deps.bundleRepository.deleteBundle(bundleId, userId);
      return null;
    }

    // Nothing is enqueued here: PENDING is the feeder's claim signal. A row left
    // at PENDING for a type that can never render would be claimed again and
    // again, so those are marked UNSUPPORTED instead.
    if (thumbUnsupportedIds.length > 0) await deps.repository.markThumbUnsupported(thumbUnsupportedIds);
    if (textUnsupportedIds.length > 0) await deps.repository.markTextUnsupported(textUnsupportedIds);

    await deps.bundleRepository.addItems(bundleId, userId, createdIds);

    if (coverCandidateId) {
      await deps.bundleRepository.updateBundle(bundleId, userId, { coverMediaId: coverCandidateId });
    }

    await deps.repository.setLinkedBundle(mediaId, bundleId);
    await deps.bundleRepository.setSourceMedia(bundleId, mediaId);

    // Open library views have no other signal that these items appeared.
    deps.publishJobUpdate?.({ userId, mediaId: "*", field: "mediaCreated", value: String(createdIds.length) });

    return { bundleId };
  };

  /**
   * Queues an unpack for whichever of `ids` are archives. A failed enqueue is
   * logged rather than thrown, so `queued` is the only signal a caller gets.
   * A missing `unpackQueue` throws instead of returning zero.
   */
  const enqueueUnpackForArchives = async (
    userId: string,
    ids: string[],
    allowedRoots: string[],
  ): Promise<{ queued: number }> => {
    const unpackQueue = deps.unpackQueue;
    if (!unpackQueue) throw new Error("archiveService: enqueueUnpackForArchives needs an unpackQueue");
    const candidates = await deps.repository.findMimeTypesByIds(userId, ids);
    let queued = 0;
    for (const candidate of candidates) {
      if (!ARCHIVE_MIME_TYPES.has(candidate.mimeType)) continue;
      await enqueueUnpack(unpackQueue, {
        mediaId: candidate.id,
        userId,
        mimeType: candidate.mimeType,
        allowedRoots,
      })
        .then(() => { queued++; })
        .catch((err: unknown) => deps.logger.warn({ err, mediaId: candidate.id }, "failed to enqueue unpack"));
    }
    return { queued };
  };

  return {
    getBulkDownloadItems,
    streamBulkArchive,
    unpackArchive,
    enqueueUnpackForArchives,
  };
}
