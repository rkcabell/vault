import { randomUUID } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import type { Job, Processor, Queue } from "bullmq";
import type { Prisma } from "@prisma/client";
import type { MediaRepository } from "../repositories/mediaRepository.js";
import type { ThumbJob } from "../queues/enqueueThumbnail.js";
import type { OcrJobData } from "../services/ocrProcessingService.js";
import { enqueueThumbBulk } from "../queues/enqueueThumbnail.js";
import { enqueueOcrBulk } from "../queues/enqueueOcr.js";
import type { IndexJobData, IndexJobProgress } from "../queues/enqueueIndex.js";
import { assertUnderAllowedRoot } from "../lib/media/indexRoots.js";
import { mimeFromExtension } from "../lib/media/mimeFromExtension.js";
import { normalizeMimeType, buildMimeTypeTag } from "../lib/tags/mimeTypeTag.js";
import { normalizeTags } from "../lib/tags/normalizeTags.js";
import { deriveTitle } from "../lib/media/deriveTitle.js";

type IndexLogger = {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
  error: (obj: object, msg: string) => void;
};

type IndexWorkerDeps = {
  mediaRepository: MediaRepository;
  thumbQueue: Queue<ThumbJob>;
  ocrQueue: Queue<OcrJobData>;
  logger: IndexLogger;
};

/** How many discovered files to insert + enqueue per batch. */
const BATCH_SIZE = 200;

/** OCR only runs on images and PDFs (mirrors mediaUploadService.finalizeBatch). */
function ocrSupported (mimeType: string): boolean {
  const m = mimeType.toLowerCase();
  return m === "" || m.startsWith("image/") || m.includes("pdf");
}

type DiscoveredFile = { absPath: string; name: string; size: number };

/**
 * Walk a directory yielding regular files. Symlinks are never followed or
 * indexed — that both prevents directory-loop hangs and stops a symlink from
 * pointing the source read outside the allow-listed root.
 */
async function* walk (
  dir: string,
  recursive: boolean,
  ignoreHidden: boolean,
): AsyncGenerator<DiscoveredFile> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // unreadable directory — skip rather than abort the whole scan
  }
  for (const entry of entries) {
    if (ignoreHidden && entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    let st;
    try {
      st = await lstat(full);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      if (recursive) yield* walk(full, recursive, ignoreHidden);
    } else if (st.isFile()) {
      yield { absPath: full, name: entry.name, size: st.size };
    }
  }
}

/**
 * Index one batch of discovered files: skip already-indexed paths, create Media
 * rows that reference the file in place (sourcePath set, sourceState READY), and
 * enqueue thumbnail + OCR work. Returns how many were newly indexed vs skipped.
 */
async function indexBatch (
  deps: IndexWorkerDeps,
  userId: string,
  files: DiscoveredFile[],
  allowedRoots: string[],
): Promise<{ indexed: number; skipped: number }> {
  const existing = await deps.mediaRepository.findExistingSourcePaths(
    userId,
    files.map(f => f.absPath),
  );
  const fresh = files.filter(f => !existing.has(f.absPath));
  if (fresh.length === 0) return { indexed: 0, skipped: files.length };

  const rows: Prisma.MediaCreateManyInput[] = [];
  const thumbItems: { mediaId: string; userId: string; storageKey: string; sourcePath: string; allowedRoots: string[] }[] = [];
  const ocrItems: { mediaId: string; userId: string; storageKey: string; allowedRoots: string[] }[] = [];
  const unsupportedIds: string[] = [];

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

    thumbItems.push({ mediaId: id, userId, storageKey, sourcePath: file.absPath, allowedRoots });
    if (ocrSupported(mimeType)) ocrItems.push({ mediaId: id, userId, storageKey, allowedRoots });
    else unsupportedIds.push(id);
  }

  // skipDuplicates tolerates a race on the (userId, sourcePath) unique index.
  await deps.mediaRepository.createBatch(rows, { skipDuplicates: true });

  await Promise.all([
    enqueueThumbBulk(deps.thumbQueue, thumbItems),
    ocrItems.length > 0 ? enqueueOcrBulk(deps.ocrQueue, ocrItems) : Promise.resolve(),
    unsupportedIds.length > 0
      ? deps.mediaRepository.markTextUnsupported(unsupportedIds)
      : Promise.resolve(),
  ]);

  return { indexed: fresh.length, skipped: files.length - fresh.length };
}

export function createIndexProcessor (deps: IndexWorkerDeps): Processor<IndexJobData> {
  return async (job: Job<IndexJobData>) => {
    const { userId, rootPath, recursive, ignoreHidden, allowedRoots } = job.data;

    // allowedRoots is snapshotted at enqueue time — a queued path is never trusted without it.
    const root = assertUnderAllowedRoot(rootPath, allowedRoots);
    deps.logger.info({ userId, root, recursive }, "index scan started");

    const progress: IndexJobProgress = { scanned: 0, indexed: 0, skipped: 0 };
    let batch: DiscoveredFile[] = [];

    const flush = async () => {
      if (batch.length === 0) return;
      const { indexed, skipped } = await indexBatch(deps, userId, batch, allowedRoots);
      progress.indexed += indexed;
      progress.skipped += skipped;
      batch = [];
      await job.updateProgress(progress);
    };

    for await (const file of walk(root, recursive, ignoreHidden)) {
      batch.push(file);
      progress.scanned++;
      if (batch.length >= BATCH_SIZE) await flush();
    }
    await flush();

    deps.logger.info({ userId, root, ...progress }, "index scan completed");
    return progress;
  };
}
