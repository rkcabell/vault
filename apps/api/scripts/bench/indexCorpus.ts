/**
 * Indexes a benchmark corpus without the API or Redis. The index worker is a
 * wrapper over `walkFiles` and `indexFiles`, so calling those directly produces
 * the same rows.
 *
 *   tsx scripts/bench/indexCorpus.ts --root E:\vault-bench\corpus
 */

import { prisma } from "@vault/db";
import { walkFiles } from "../../src/worker/indexWalk.js";
import { indexFiles, type DiscoveredFile } from "../../src/worker/indexCore.js";
import { MediaRepository } from "../../src/repositories/mediaRepository.js";

const BATCH_SIZE = 200; // Matches the batch size indexWorker uses.

function parseArgs (argv: string[]) {
  let root = "", userId = "", purge = false;
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--root") root = argv[++i];
    else if (k === "--user") userId = argv[++i];
    else if (k === "--purge") purge = true;
    else throw new Error(`Unknown argument: ${k}`);
  }
  if (!root) throw new Error("--root <corpus dir> is required");
  return { root, userId, purge };
}

/**
 * Returns the id of every Media row whose `sourcePath` is under `root`.
 *
 * Uses `starts_with` rather than Prisma's `startsWith`. The latter compiles to
 * LIKE, whose escape character is backslash, so a Windows path prefix matches
 * nothing.
 */
function scopedIds (root: string) {
  return prisma.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Media" WHERE starts_with("sourcePath", ${root})
  `;
}

async function main () {
  const args = parseArgs(process.argv.slice(2));
  const userId = args.userId || (await prisma.user.findFirst({ select: { id: true } }))?.id;
  if (!userId) throw new Error("no User row to index against");

  if (args.purge) {
    const ids = (await scopedIds(args.root)).map(r => r.id);
    if (ids.length) {
      await prisma.document.deleteMany({ where: { mediaId: { in: ids } } });
      await prisma.media.deleteMany({ where: { id: { in: ids } } });
    }
    console.log(`purged ${ids.length} existing rows under ${args.root}`);
  }

  // Hash jobs are omitted so they add no disk reads to a timed sample. Tag rules
  // are omitted because they change index duration but not derivative duration.
  const deps = { mediaRepository: new MediaRepository(prisma), listTagRules: async () => [] };
  const filters = {
    recursive: true,
    ignoreHidden: true,
    blacklist: [] as string[],
    excludeFolders: [] as string[],
    skipNonContent: false, // The corpus contains only content files.
  };

  const started = Date.now();
  const stats = { filtered: 0 };
  let batch: DiscoveredFile[] = [];
  let indexed = 0, skipped = 0, scanned = 0;

  const flush = async () => {
    if (batch.length === 0) return;
    const r = await indexFiles(deps, userId, batch, [args.root]);
    indexed += r.indexed;
    skipped += r.skipped;
    batch = [];
    process.stdout.write(`\r  scanned ${scanned}  indexed ${indexed}  skipped ${skipped}   `);
  };

  for await (const file of walkFiles(args.root, filters, stats)) {
    batch.push(file);
    scanned += 1;
    if (batch.length >= BATCH_SIZE) await flush();
  }
  await flush();

  const elapsed = (Date.now() - started) / 1000;
  process.stdout.write("\r".padEnd(60) + "\r");
  console.log(`walk+index: ${scanned} files in ${elapsed.toFixed(1)}s (${(scanned / elapsed).toFixed(0)}/s)`);
  console.log(`  indexed ${indexed}, skipped ${skipped} (already present), filtered ${stats.filtered}`);

  const byState = await prisma.$queryRaw<{ thumbState: string; textState: string; n: bigint }[]>`
    SELECT "thumbState", "textState", count(*) AS n
    FROM "Media" WHERE starts_with("sourcePath", ${args.root})
    GROUP BY 1, 2 ORDER BY n DESC
  `;
  console.log("\nrow states:");
  for (const g of byState) {
    console.log(`  thumb=${g.thumbState.padEnd(11)} text=${g.textState.padEnd(11)} ${g.n}`);
  }
}

main()
  .catch(err => { console.error(err instanceof Error ? err.message : err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
