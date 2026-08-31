/**
 * Returns a corpus to its just-indexed state so that a sweep can be run against
 * it a second time. Requires `--scope`, so it cannot reset a real library.
 *
 *   tsx scripts/bench/resetDerivatives.ts --scope E:\vault-bench\corpus
 */

import { prisma } from "@vault/db";
import { planDerivations } from "../../src/worker/indexCore.js";

type Kind = "thumb" | "text" | "all";

function parseArgs (argv: string[]) {
  let scope = "", kind: Kind = "all", clearHashes = false, dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--scope") scope = argv[++i];
    else if (k === "--kind") kind = argv[++i] as Kind;
    else if (k === "--clear-hashes") clearHashes = true;
    else if (k === "--dry-run") dryRun = true;
    else throw new Error(`Unknown argument: ${k}`);
  }
  if (!scope) throw new Error("--scope <corpus root> is required — refusing to reset an unscoped library");
  return { scope, kind, clearHashes, dryRun };
}

/**
 * Returns the id, media type and size of every Media row whose `sourcePath` is
 * under `scope`.
 *
 * Uses `starts_with` rather than Prisma's `startsWith`. The latter compiles to
 * LIKE, whose default escape character is backslash, so a Windows path prefix
 * matches nothing.
 */
async function scopedRows (scope: string) {
  return prisma.$queryRaw<{ id: string; mimeType: string | null; sizeBytes: bigint | number | null }[]>`
    SELECT "id", "mimeType", "sizeBytes" FROM "Media" WHERE starts_with("sourcePath", ${scope})
  `;
}

async function main () {
  const { scope, kind, clearHashes, dryRun } = parseArgs(process.argv.slice(2));

  const rows = await scopedRows(scope);
  if (rows.length === 0) {
    console.log(`no rows under ${scope} — nothing to reset (has the corpus been indexed?)`);
    return;
  }

  const thumbPending: string[] = [];
  const thumbUnsupported: string[] = [];
  const textPending: string[] = [];
  const textUnsupported: string[] = [];

  // Target state is re-derived rather than set to PENDING for every row: a .txt
  // file has no thumbnail and a .bin file has no text.
  for (const r of rows) {
    const plan = planDerivations(r.mimeType ?? "", Number(r.sizeBytes ?? 0));
    (plan.thumb ? thumbPending : thumbUnsupported).push(r.id);
    (plan.text ? textPending : textUnsupported).push(r.id);
  }

  console.log(`scope   : ${scope}`);
  console.log(`rows    : ${rows.length}`);
  if (kind !== "text") console.log(`  thumb → PENDING ${thumbPending.length}, UNSUPPORTED ${thumbUnsupported.length}`);
  if (kind !== "thumb") console.log(`  text  → PENDING ${textPending.length}, UNSUPPORTED ${textUnsupported.length}`);
  if (clearHashes) console.log(`  contentHash → NULL (all ${rows.length})`);
  if (dryRun) { console.log("\n--dry-run: nothing written"); return; }

  // Splits ids so that one reset is a few updateMany calls rather than one per row.
  const chunk = <T>(xs: T[], n = 1000) =>
    Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

  if (kind !== "text") {
    for (const ids of chunk(thumbPending)) {
      await prisma.media.updateMany({
        where: { id: { in: ids } },
        // Clearing thumbnailKey is required. processThumb returns early when a
        // thumbnail already exists, so every run after the first would do no work.
        data: { thumbState: "PENDING", thumbQueuedAt: null, thumbError: null, thumbnailKey: null },
      });
    }
    for (const ids of chunk(thumbUnsupported)) {
      await prisma.media.updateMany({
        where: { id: { in: ids } },
        data: { thumbState: "UNSUPPORTED", thumbQueuedAt: null },
      });
    }
  }

  if (kind !== "thumb") {
    for (const ids of chunk(textPending)) {
      await prisma.media.updateMany({
        where: { id: { in: ids } },
        data: { textState: "PENDING", textQueuedAt: null },
      });
    }
    for (const ids of chunk(textUnsupported)) {
      await prisma.media.updateMany({
        where: { id: { in: ids } },
        data: { textState: "UNSUPPORTED", textQueuedAt: null },
      });
    }
    // Deleting extracted text keeps a later run an INSERT rather than an UPDATE,
    // which is what the first run measured. Text is upserted, so correctness does
    // not depend on this.
    for (const ids of chunk(rows.map(r => r.id))) {
      await prisma.document.deleteMany({ where: { mediaId: { in: ids } } });
    }
  }

  if (clearHashes) {
    for (const ids of chunk(rows.map(r => r.id))) {
      await prisma.media.updateMany({ where: { id: { in: ids } }, data: { contentHash: null } });
    }
  }

  const after = await prisma.$queryRaw<{ thumbState: string; textState: string; n: bigint }[]>`
    SELECT "thumbState", "textState", count(*) AS n
    FROM "Media" WHERE starts_with("sourcePath", ${scope})
    GROUP BY 1, 2 ORDER BY n DESC
  `;
  console.log("\nafter:");
  for (const g of after) console.log(`  thumb=${g.thumbState.padEnd(11)} text=${g.textState.padEnd(11)} ${g.n}`);
}

main()
  .catch(err => { console.error(err instanceof Error ? err.message : err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
