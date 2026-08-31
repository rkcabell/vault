import { stat, unlink } from "node:fs/promises";
import type { FastifyBaseLogger } from "fastify";
import type { Readable } from "node:stream";
import type { MediaRepository } from "../../repositories/mediaRepository.js";
import { getUploadSizeError, HARD_UPLOAD_LIMIT_BYTES } from "../../lib/media/ingestLimits.js";
import { mimeFromExtension } from "../../lib/media/mimeFromExtension.js";
import { normalizeMimeType } from "../../lib/tags/mimeTypeTag.js";
import { canonicalizeAbsPath, isUnderAllowedRoot } from "../../lib/media/indexRoots.js";
import { writeIngestFile, IngestStreamTooLargeError, type IngestWriteResult } from "../../lib/media/ingestWrite.js";
// One code path creates every Media row: the indexer.
import { indexFiles, type IndexCoreDeps } from "../../worker/indexCore.js";

/**
 * Accepts a file sent over HTTP. The bytes are written into a folder the user
 * chose inside their own index roots, and the ordinary indexer creates the row
 * in the same request. Nothing is copied into managed storage.
 */

/** Why sending files is unavailable. */
export type IngestDisabledReason = "no-roots" | "not-set" | "outside-roots" | "missing";

export type IngestTarget =
  | { enabled: true; folderPath: string; allowedRoots: string[] }
  | { enabled: false; folderPath: string | null; reason: IngestDisabledReason };

/** Signals that a sent file has no usable destination folder. */
export class IngestNotConfiguredError extends Error {
  code = "INGEST_NOT_CONFIGURED";
  constructor (public reason: IngestDisabledReason) {
    super(`No folder is configured for sent files (${reason})`);
    this.name = "IngestNotConfiguredError";
  }
}

/** Signals that the bytes that arrived exceed the per-file limit. */
export class IngestTooLargeError extends Error {
  code = "INGEST_TOO_LARGE";
  constructor (message: string) {
    super(message);
    this.name = "IngestTooLargeError";
  }
}

type IngestDeps = IndexCoreDeps & {
  mediaRepository: MediaRepository;
  logger: FastifyBaseLogger;
  getIngestConfig: (userId: string) => Promise<{ folderPath: string | null; allowedRoots: string[] }>;
  writeFile?: typeof writeIngestFile;
  indexFilesFn?: typeof indexFiles;
};

export type IngestResult = {
  id: string;
  savedAs: string;
  renamed: boolean;
  sourcePath: string;
  sizeBytes: number;
};

export function createIngestService (deps: IngestDeps) {
  const writeFile = deps.writeFile ?? writeIngestFile;
  const runIndex = deps.indexFilesFn ?? indexFiles;

  /** Returns the folder sent files go to, or why they cannot be sent. */
  const resolveTarget = async (userId: string): Promise<IngestTarget> => {
    const { folderPath, allowedRoots } = await deps.getIngestConfig(userId);
    if (allowedRoots.length === 0) return { enabled: false, folderPath, reason: "no-roots" };
    if (!folderPath) return { enabled: false, folderPath: null, reason: "not-set" };
    if (!isUnderAllowedRoot(folderPath, allowedRoots)) {
      return { enabled: false, folderPath, reason: "outside-roots" };
    }
    const dir = await stat(folderPath).catch(() => null);
    if (!dir?.isDirectory()) return { enabled: false, folderPath, reason: "missing" };
    return { enabled: true, folderPath, allowedRoots };
  };

  const ingestFile = async (
    userId: string,
    input: { filename: string; body: Readable },
  ): Promise<IngestResult> => {
    const target = await resolveTarget(userId);
    if (!target.enabled) throw new IngestNotConfiguredError(target.reason);

    let written: IngestWriteResult;
    try {
      written = await writeFile(target.folderPath, input.filename, input.body, HARD_UPLOAD_LIMIT_BYTES);
    } catch (err) {
      // `writeIngestFile` cannot throw IngestTooLargeError without an import
      // cycle, so its own error is mapped here. Callers see only this one.
      if (err instanceof IngestStreamTooLargeError) throw new IngestTooLargeError(err.message);
      throw err;
    }
    const mimeType = normalizeMimeType(mimeFromExtension(written.savedAs), written.savedAs);

    // Checked against the bytes written, not the Content-Length header. An
    // over-limit file is removed again; `writeIngestFile` created it under a
    // name that was free, so nothing of the user's own is deleted.
    const sizeError = getUploadSizeError({
      filename: written.savedAs,
      mimeType,
      sizeBytes: written.sizeBytes,
    });
    if (sizeError) {
      await unlink(written.path).catch(err =>
        deps.logger.warn({ err, path: written.path }, "ingest: could not remove oversize file"),
      );
      throw new IngestTooLargeError(sizeError);
    }

    await runIndex(
      deps,
      userId,
      [{
        absPath: written.path,
        name: written.savedAs,
        size: written.sizeBytes,
        mtimeMs: written.mtimeMs,
      }],
      target.allowedRoots,
      // Sent files carry the source:upload tag axis, so a rule keyed on it
      // still matches them.
      { ingestSource: "upload" },
    );

    // The live watcher can create the row for this file first, in which case
    // `indexFiles` skipped it. The id is read back by path for that reason, in
    // the canonical form `indexFiles` stores.
    const sourcePath = canonicalizeAbsPath(written.path);
    const id = await deps.mediaRepository.findIdBySourcePath(userId, sourcePath);
    if (!id) {
      throw new Error(`Ingested ${sourcePath} but no media row exists for it`);
    }

    return {
      id,
      savedAs: written.savedAs,
      renamed: written.renamed,
      sourcePath,
      sizeBytes: written.sizeBytes,
    };
  };

  return { resolveTarget, ingestFile };
}
