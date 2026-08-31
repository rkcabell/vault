/**
 * Put a corpus back to "just indexed" so a sweep run can be repeated.
 *
 * Two traps:
 *  - Not every row goes back to PENDING. A .txt has no thumbnail, a .bin no
 *    text. Target state is re-derived from planDerivations, not copied.
 *  - thumbnailKey must be cleared, or processThumb returns early and every run
 *    after the first is a no-op reporting spectacular throughput.
 *
 * Refuses to run unscoped, so it cannot touch a real library.
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
 * `starts_with`, not Prisma's `startsWith`: the latter compiles to LIKE, whose
 * default escape character is backslash, so a Windows path prefix silently
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

  // Chunked so one reset is a few updateMany calls, not one per row.
  const chunk = <T>(xs: T[], n = 1000) =>
    Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

  if (kind !== "text") {
    for (const ids of chunk(thumbPending)) {
      await prisma.media.updateMany({
        where: { id: { in: ids } },
        // thumbnailKey: null is the load-bearing part — see the header.
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
    // Not needed for correctness (text is upserted), but leaving these makes
    // later runs an UPDATE rather than an INSERT, biasing the sweep.
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
