import { lstat } from "node:fs/promises";
import type { Job, Processor } from "bullmq";
import type { OrganizeJobData, OrganizeJobProgress } from "../queues/enqueueOrganize.js";
import type { OrganizePreviewItem } from "@vault/types";
import { evaluateRules, type TagRuleInput } from "../lib/tags/rules/evaluateRules.js";
import { resolveFileDate } from "../lib/tags/rules/fileDate.js";
import type { MediaMetadata } from "../services/media/metadata/types.js";

type OrganizeLogger = {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
};

/** One media row as the organize scan reads it (keyset-paged by id). */
export type OrganizeMediaRow = {
  id: string;
  title: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sourcePath: string | null;
  isExtractedFromArchive: boolean;
  tags: string[];
  /** Stored fileDate column value — compared against the freshly resolved date. */
  fileDate: Date | null;
  /** MediaExtractedMetadata.data when present (EXIF/PDF dates live here). */
  metadata: unknown | null;
};

/** Structural deps so the worker is unit-testable with simple fakes (mirrors
 *  the deleteWorker convention). */
type OrganizeWorkerDeps = {
  mediaRepository: {
    countMediaForOrganize: (userId: string) => Promise<number>;
    listMediaForOrganize: (userId: string, afterId: string | null, limit: number) => Promise<OrganizeMediaRow[]>;
    addTagsToMedia: (userId: string, mediaId: string, tags: string[]) => Promise<void>;
    ensureAutoTagRows: (userId: string, names: string[]) => Promise<void>;
    reconcileTagCounts: (userId: string) => Promise<void>;
    setFileDate: (mediaId: string, fileDate: Date) => Promise<void>;
  };
  tagRuleRepository: {
    listEnabled: (userId: string) => Promise<TagRuleInput[]>;
  };
  /** The user's in-place index roots (for `folder:` segments + ingest source). */
  getIndexRoots: (userId: string) => Promise<string[]>;
  logger: OrganizeLogger;
  /** Publishes a media event so open views refresh tags. Optional in tests. */
  publishJobUpdate?: (update: { userId: string; mediaId: string; field: string; value: string }) => void;
  /** Stat used for the mtime date fallback on indexed items. Test seam. */
  statFile?: (absPath: string) => Promise<{ mtimeMs: number }>;
  /** Rows per page (tests use a small value). */
  chunkSize?: number;
};

const CHUNK_SIZE = 500;
/** Caps that keep the progress payload (stored in Redis) small. */
const MAX_TAG_COUNT_KEYS = 200;
const MAX_SAMPLE_ITEMS = 20;

export function createOrganizeProcessor (deps: OrganizeWorkerDeps): Processor<OrganizeJobData> {
  const chunkSize = deps.chunkSize ?? CHUNK_SIZE;
  const statFile = deps.statFile ?? (async (p: string) => lstat(p));

  return async (job: Job<OrganizeJobData>) => {
    const { userId, dryRun } = job.data;

    const rules = await deps.tagRuleRepository.listEnabled(userId);
    const indexRoots = await deps.getIndexRoots(userId);
    const needsFileDate = rules.some(r => r.source === "FILE_DATE");
    const total = await deps.mediaRepository.countMediaForOrganize(userId);

    const progress: OrganizeJobProgress = {
      dryRun,
      total,
      processed: 0,
      updated: 0,
      tagsAdded: 0,
      tagCounts: {},
    };
    const sample: OrganizePreviewItem[] = [];
    await job.updateProgress(progress);
    deps.logger.info({ userId, total, dryRun, rules: rules.length }, "organize run started");

    // Distinct tags actually written — their Tag rows are ensured before the
    // final reconcile (reconcileTagCounts only fixes tags that HAVE a row).
    const appliedTags = new Set<string>();
    let wrote = false;
    let afterId: string | null = null;

    try {
      while (true) {
        const rows = await deps.mediaRepository.listMediaForOrganize(userId, afterId, chunkSize);
        if (rows.length === 0) break;
        afterId = rows[rows.length - 1].id;

        for (const row of rows) {
          progress.processed++;

          const ingest = row.sourcePath ? "index" : row.isExtractedFromArchive ? "unpacked" : "upload";
          let fileDate = resolveFileDate(row.metadata as MediaMetadata | null);
          if (!fileDate && (needsFileDate || row.fileDate === null) && row.sourcePath) {
            // mtime fallback for indexed items with no embedded date. Missing /
            // unreadable source → no date tag, never a failed run. Also taken
            // when the fileDate column is unset so a plain Organize run
            // backfills it even without a FILE_DATE rule.
            fileDate = await statFile(row.sourcePath)
              .then(st => (st.mtimeMs > 0 ? new Date(st.mtimeMs) : null))
              .catch(() => null);
          }

          // Keep the fileDate column in sync with the freshly resolved date —
          // this is how pre-existing rows acquire fileDate for the "Year" sort
          // (run Organize once after upgrading). Derived data, but still a
          // write, so skipped on dry runs.
          if (!dryRun && fileDate && fileDate.getTime() !== row.fileDate?.getTime()) {
            await deps.mediaRepository.setFileDate(row.id, fileDate);
          }

          const evaluated = evaluateRules(rules, {
            filename: row.filename,
            mimeType: row.mimeType,
            sizeBytes: row.sizeBytes,
            sourcePath: row.sourcePath,
            indexRoots,
            fileDate,
            ingest,
          });
          const missing = evaluated.filter(tag => !row.tags.includes(tag));
          if (missing.length === 0) continue;

          progress.updated++;
          progress.tagsAdded += missing.length;
          for (const tag of missing) {
            if (progress.tagCounts[tag] !== undefined || Object.keys(progress.tagCounts).length < MAX_TAG_COUNT_KEYS) {
              progress.tagCounts[tag] = (progress.tagCounts[tag] ?? 0) + 1;
            }
          }

          if (dryRun) {
            if (sample.length < MAX_SAMPLE_ITEMS) {
              sample.push({ mediaId: row.id, title: row.title, addTags: missing });
            }
          } else {
            await deps.mediaRepository.addTagsToMedia(userId, row.id, missing);
            for (const tag of missing) appliedTags.add(tag);
            wrote = true;
          }
        }

        if (dryRun) progress.sample = sample;
        await job.updateProgress(progress);
      }
    } finally {
      // One authoritative pass fixes every Tag.count against committed data —
      // in a finally so an unexpected throw mid-run can't leave counts drifted
      // from the chunks that already committed (mirrors deleteWorker).
      if (wrote) {
        await deps.mediaRepository.ensureAutoTagRows(userId, [...appliedTags]).catch(err =>
          deps.logger.warn({ userId, err }, "organize: ensuring tag rows failed"),
        );
        await deps.mediaRepository.reconcileTagCounts(userId).catch(err =>
          deps.logger.warn({ userId, err }, "organize: tag count reconcile failed"),
        );
        // Published after counts are consistent so the refetch sees final data.
        deps.publishJobUpdate?.({ userId, mediaId: "*", field: "tagsUpdated", value: "updated" });
      }
    }

    if (dryRun) progress.sample = sample;
    await job.updateProgress(progress);
    deps.logger.info(
      { userId, dryRun, processed: progress.processed, updated: progress.updated, tagsAdded: progress.tagsAdded },
      "organize run completed",
    );
    return progress;
  };
}
