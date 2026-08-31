/**
 * Push a batch of NEEDS_OCR rows onto ocr_queue with forceOcr, for work item
 * 15F's runbook step 3 (peak-RSS-per-concurrency figure). Mirrors what
 * mediaActionsService's "Extract all" does, without the HTTP route or the rest
 * of its dependency graph.
 *
 *   tsx scripts/bench/pushNeedsOcr.ts --user-id <id> --limit 200
 */

import { Queue } from "bullmq";
import { prisma } from "@vault/db";
import { MediaRepository } from "../../src/repositories/mediaRepository.js";
import { PreferencesRepository } from "../../src/repositories/preferencesRepository.js";
import { PreferencesService } from "../../src/services/preferencesService.js";
import { buildRedisConnection } from "../../src/lib/config/redis.js";
import { OCR_QUEUE, enqueueOcrBulk, OCR_PRIORITY_USER } from "../../src/queues/enqueueOcr.js";
import type { OcrJobData } from "../../src/services/ocrProcessingService.js";

function parseArgs (argv: string[]) {
  let userId = "", limit = 200;
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--user-id") userId = argv[++i];
    else if (k === "--limit") limit = Number.parseInt(argv[++i], 10);
    else throw new Error(`Unknown argument: ${k}`);
  }
  if (!userId) throw new Error("--user-id is required");
  return { userId, limit };
}

async function main () {
  const { userId, limit } = parseArgs(process.argv.slice(2));

  const connection = buildRedisConnection(process.env.REDIS_URL ?? "redis://localhost:6379");
  const ocrQueue = new Queue<OcrJobData>(OCR_QUEUE, { connection });
  const repository = new MediaRepository(prisma);
  const preferences = new PreferencesService(new PreferencesRepository(prisma));

  const before = await repository.countNeedsOcr(userId);
  const allowedRoots = (await preferences.getPreferences(userId)).indexAllowedRoots ?? [];

  const rows = await repository.claimNeedsOcrBatch(userId, limit);
  await enqueueOcrBulk(
    ocrQueue,
    rows.map(row => ({
      mediaId: row.id,
      userId,
      storageKey: row.storageKey,
      title: row.title,
      ...(row.sourcePath ? { sourcePath: row.sourcePath, allowedRoots } : {}),
    })),
    { priority: OCR_PRIORITY_USER },
  );

  console.log(`needs-ocr before: ${before}`);
  console.log(`claimed + pushed: ${rows.length}`);
  console.log(`needs-ocr after : ${await repository.countNeedsOcr(userId)}`);
  console.log(`ocr_queue counts: ${JSON.stringify(await ocrQueue.getJobCounts("waiting", "active", "delayed"))}`);

  await ocrQueue.close();
}

main()
  .catch(err => { console.error(err instanceof Error ? err.message : err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
