/**
 * Generate a benchmark corpus for work item 15F.
 *
 * The dev library is 73 rows, all terminal - nothing to time. The *mix* matters
 * more than the size, because each class lands on a different queue:
 *
 *   pdfText     text_queue (pdf.js, ms) + thumb_queue (page render)
 *   pdfScan     no text layer -> parks at NEEDS_OCR; real glyphs inside so a
 *               tier-2 run has something to recognise
 *   photoJpeg   thumb_queue (sharp) + text -> NEEDS_OCR
 *   screenshot  same, flat UI fills rather than photo detail
 *   plainText   text_queue direct read; thumb UNSUPPORTED at index
 *   opaque      hash_queue only
 *
 * Deterministic per --seed so a sweep compares runs, not corpora.
 *
 *   node scripts/bench/makeCorpus.mjs --out E:/vault-bench/corpus --count 5000
 */

import { mkdir, rm, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { deflateRawSync } from "node:zlib";

/** Roughly a document hoard: mostly born-digital, a real scanned minority. */
const MIX = [
  { kind: "pdfText",   weight: 34 },
  { kind: "pdfScan",   weight: 16 },
  { kind: "photoJpeg", weight: 24 },
  { kind: "screenshot", weight: 6 },
  { kind: "plainText", weight: 14 },
  { kind: "opaque",    weight:  6 },
];

/** Keeps the walk hitting many directories rather than one huge readdir. */
const FILES_PER_DIR = 120;

/** mulberry32 - deterministic, so a given --seed writes byte-identical files. */
function makeRng (seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = (
  "invoice statement receipt contract agreement quarterly annual summary report ledger " +
  "account balance payment remittance vendor supplier customer reference number total " +
  "subtotal tax shipping handling delivery warehouse inventory purchase order dispatch " +
  "policy renewal premium coverage claim adjuster settlement deductible endorsement " +
  "meeting minutes agenda action item owner deadline status blocked resolved pending"
).split(" ");

function paragraph (rng, words) {
  const out = [];
  for (let i = 0; i < words; i++) out.push(WORDS[Math.floor(rng() * WORDS.length)]);
  const s = out.join(" ");
  return s.charAt(0).toUpperCase() + s.slice(1) + ".";
}

// Lazy: --dry-run needs no native modules, and the import cost is paid once.
let _sharp, _canvas, _pdfLib;
const loadSharp  = async () => (_sharp  ??= (await import("sharp")).default);
const loadCanvas = async () => (_canvas ??= await import("@napi-rs/canvas"));
const loadPdfLib = async () => (_pdfLib ??= await import("pdf-lib"));

/** Noise upscaled then really encoded, so sharp pays a plausible decode cost. */
async function makePhoto (rng) {
  const sharp = await loadSharp();
  // Spread of real camera-ish sizes; the large end is what costs.
  const dims = [[1024, 768], [1600, 1200], [2048, 1536], [3024, 4032]];
  const [w, h] = dims[Math.floor(rng() * dims.length)];

  // Small tile upscaled: 12M raw pixels per file in JS would dominate runtime.
  const tw = 64, th = 64;
  const raw = Buffer.allocUnsafe(tw * th * 3);
  for (let i = 0; i < tw * th; i++) {
    raw[i * 3]     = Math.floor(rng() * 256);
    raw[i * 3 + 1] = Math.floor(rng() * 256);
    raw[i * 3 + 2] = Math.floor(rng() * 256);
  }
  const buf = await sharp(raw, { raw: { width: tw, height: th, channels: 3 } })
    .resize(w, h, { kernel: "cubic" })
    .jpeg({ quality: 82 })
    .toBuffer();
  return { buf, ext: "jpg" };
}

/** PNGs in a real hoard are screenshots. As photos they'd be 20 MB of
 *  incompressible noise - a case that barely exists. */
async function makeScreenshot (rng) {
  const { createCanvas } = await loadCanvas();
  const dims = [[1920, 1080], [1440, 900], [2560, 1440], [1366, 768]];
  const [W, H] = dims[Math.floor(rng() * dims.length)];
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#f4f5f7";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#23262b";
  ctx.fillRect(0, 0, W, 56);          // title bar
  ctx.fillRect(0, 56, 220, H - 56);   // sidebar

  for (let i = 0; i < 18; i++) {
    const x = 250 + Math.floor(rng() * (W - 500));
    const y = 90 + Math.floor(rng() * (H - 220));
    const w = 120 + Math.floor(rng() * 320);
    const h = 40 + Math.floor(rng() * 120);
    ctx.fillStyle = `hsl(${Math.floor(rng() * 360)}, 30%, ${70 + Math.floor(rng() * 20)}%)`;
    ctx.fillRect(x, y, w, h);
  }
  ctx.fillStyle = "#2b2f36";
  ctx.font = "18px sans-serif";
  for (let i = 0; i < 14; i++) {
    ctx.fillText(paragraph(rng, 6 + Math.floor(rng() * 5)), 250, 120 + i * 34);
  }
  return { buf: await canvas.encode("png"), ext: "png" };
}

/** Real glyphs, so a tier-2 run measures the success path rather than the
 *  much cheaper failure path. */
async function makeScanPage (rng, lines) {
  const { createCanvas } = await loadCanvas();
  const W = 1275, H = 1650; // 150 dpi Letter — a typical scan resolution
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#fdfdfa";
  ctx.fillRect(0, 0, W, H);
  // Speckle: a pure-white background denoises for free, which no scan does.
  for (let i = 0; i < 4000; i++) {
    const g = 200 + Math.floor(rng() * 40);
    ctx.fillStyle = `rgb(${g},${g},${g})`;
    ctx.fillRect(Math.floor(rng() * W), Math.floor(rng() * H), 1, 1);
  }
  ctx.fillStyle = "#1a1a1a";
  ctx.font = "28px sans-serif";
  let y = 120;
  for (let i = 0; i < lines; i++) {
    ctx.fillText(paragraph(rng, 8 + Math.floor(rng() * 4)), 90, y);
    y += 44;
    if (y > H - 90) break;
  }
  return canvas.encode("jpeg", 78);
}

/** Born-digital PDF: a real text layer, so tier 1 finishes it in milliseconds. */
async function makePdfText (rng) {
  const { PDFDocument, StandardFonts, rgb } = await loadPdfLib();
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = 1 + Math.floor(rng() * 6);
  for (let p = 0; p < pages; p++) {
    const page = doc.addPage([612, 792]);
    let y = 730;
    for (let i = 0; i < 24 && y > 60; i++) {
      page.drawText(paragraph(rng, 9 + Math.floor(rng() * 3)), {
        x: 56, y, size: 11, font, color: rgb(0.1, 0.1, 0.1), maxWidth: 500,
      });
      y -= 28;
    }
  }
  return Buffer.from(await doc.save());
}

/** Image-only PDF: no text layer at all, which is what parks a row at NEEDS_OCR. */
async function makePdfScan (rng) {
  const { PDFDocument } = await loadPdfLib();
  const doc = await PDFDocument.create();
  const pages = 1 + Math.floor(rng() * 3);
  for (let p = 0; p < pages; p++) {
    const jpeg = await makeScanPage(rng, 20 + Math.floor(rng() * 10));
    const img = await doc.embedJpg(jpeg);
    const page = doc.addPage([612, 792]);
    page.drawImage(img, { x: 0, y: 0, width: 612, height: 792 });
  }
  return Buffer.from(await doc.save());
}

function makePlainText (rng) {
  const paras = 8 + Math.floor(rng() * 60);
  const out = [];
  for (let i = 0; i < paras; i++) out.push(paragraph(rng, 30 + Math.floor(rng() * 70)));
  return Buffer.from(out.join("\n\n"), "utf8");
}

/** No derivative possible - exercises the hash path. Incompressible, so the
 *  hash job really reads bytes. */
function makeOpaque (rng) {
  const size = 64 * 1024 + Math.floor(rng() * 512 * 1024);
  const buf = Buffer.allocUnsafe(size);
  for (let i = 0; i < size; i += 4) buf.writeUInt32LE((rng() * 0xffffffff) >>> 0, Math.min(i, size - 4));
  return deflateRawSync(buf);
}

// ---------------------------------------------------------------------------

function parseArgs (argv) {
  // Above ~4 the @napi-rs/canvas encoder dies with no JS error, stopping
  // mid-run after a few hundred files (and exiting 0 through a pipe).
  const args = { out: "", count: 5000, seed: 1, clean: false, concurrency: 4, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") args.out = argv[++i];
    else if (a === "--count") args.count = Number.parseInt(argv[++i], 10);
    else if (a === "--seed") args.seed = Number.parseInt(argv[++i], 10);
    else if (a === "--concurrency") args.concurrency = Number.parseInt(argv[++i], 10);
    else if (a === "--clean") args.clean = true;
    else if (a === "--dry-run") args.dryRun = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!args.out) throw new Error("--out <dir> is required");
  if (!Number.isFinite(args.count) || args.count < 1) throw new Error("--count must be a positive integer");
  return args;
}

/** Expand the weighted mix into a concrete, deterministic plan of `count` items. */
function buildPlan (count, seed) {
  const rng = makeRng(seed);
  const total = MIX.reduce((s, m) => s + m.weight, 0);
  const plan = [];
  for (const m of MIX) {
    const n = Math.round((m.weight / total) * count);
    for (let i = 0; i < n; i++) plan.push(m.kind);
  }
  // Rounding drift.
  while (plan.length < count) plan.push("pdfText");
  while (plan.length > count) plan.pop();
  // Interleave kinds; a type-sorted corpus feeds workers homogeneous runs.
  for (let i = plan.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [plan[i], plan[j]] = [plan[j], plan[i]];
  }
  return plan;
}

const EXT = { pdfText: "pdf", pdfScan: "pdf", photoJpeg: "jpg", screenshot: "png", plainText: "txt", opaque: "bin" };

async function generate (kind, rng) {
  switch (kind) {
    case "pdfText":   return { buf: await makePdfText(rng),        ext: "pdf" };
    case "pdfScan":   return { buf: await makePdfScan(rng),        ext: "pdf" };
    case "photoJpeg": return await makePhoto(rng);
    case "screenshot": return await makeScreenshot(rng);
    case "plainText": return { buf: makePlainText(rng),            ext: "txt" };
    case "opaque":    return { buf: makeOpaque(rng),               ext: "bin" };
    default: throw new Error(`unknown kind ${kind}`);
  }
}

async function main () {
  const args = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(args.out);
  const plan = buildPlan(args.count, args.seed);

  const byKind = {};
  for (const k of plan) byKind[k] = (byKind[k] ?? 0) + 1;

  console.log(`corpus  : ${outDir}`);
  console.log(`count   : ${plan.length}  (seed ${args.seed})`);
  for (const [k, n] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(10)} ${String(n).padStart(6)}  → .${EXT[k]}`);
  }
  if (args.dryRun) return;

  // --clean deletes recursively; a mistyped --out must not take a real folder.
  if (args.clean) {
    const marker = path.join(outDir, ".vault-bench-corpus");
    let owned = false;
    try { await stat(marker); owned = true; } catch { /* not ours (or absent) */ }
    let exists = true;
    try { await stat(outDir); } catch { exists = false; }
    if (exists && !owned) {
      throw new Error(
        `--clean refused: ${outDir} exists and has no .vault-bench-corpus marker. ` +
        `Delete it yourself if you are sure.`,
      );
    }
    if (exists) await rm(outDir, { recursive: true, force: true });
  }

  await mkdir(outDir, { recursive: true });
  await writeFile(
    path.join(outDir, ".vault-bench-corpus"),
    `generated ${new Date().toISOString()}\nseed=${args.seed}\ncount=${plan.length}\n`,
    "utf8",
  );

  const dirCount = Math.max(1, Math.ceil(plan.length / FILES_PER_DIR));
  for (let d = 0; d < dirCount; d++) {
    await mkdir(path.join(outDir, `batch-${String(d).padStart(4, "0")}`), { recursive: true });
  }

  // Per-index RNG: a shared one would make output depend on completion order.
  let done = 0, bytes = 0;
  const started = Date.now();
  let next = 0;

  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= plan.length) return;
      const kind = plan[i];
      const rng = makeRng(args.seed * 1_000_003 + i);
      const { buf, ext } = await generate(kind, rng);
      const dir = path.join(outDir, `batch-${String(Math.floor(i / FILES_PER_DIR)).padStart(4, "0")}`);
      const name = `${kind}-${String(i).padStart(6, "0")}.${ext}`;
      await writeFile(path.join(dir, name), buf);
      bytes += buf.length;
      done += 1;
      if (done % 250 === 0) {
        const rate = done / ((Date.now() - started) / 1000);
        process.stdout.write(
          `\r  ${done}/${plan.length}  ${(bytes / 1e6).toFixed(0)} MB  ${rate.toFixed(0)}/s   `,
        );
      }
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, args.concurrency) }, worker));

  const elapsed = (Date.now() - started) / 1000;
  process.stdout.write("\r".padEnd(60) + "\r");
  console.log(
    `wrote ${done} files, ${(bytes / 1e6).toFixed(0)} MB in ${elapsed.toFixed(1)}s ` +
    `(${(bytes / done / 1024).toFixed(0)} KB avg)`,
  );
  console.log(`\nAdd ${outDir} as an index root, then scan it.`);
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
