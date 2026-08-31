/**
 * 15F sampler: joins queue depth, database backlog and process cost (CPU/RSS/
 * disk) into one CSV timeline.
 *
 *   tsx scripts/bench/measure.ts --label thumb-c8 --scope E:\corpus \
 *     --pids 1234 --drain thumb --out ./bench-results
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { Queue } from "bullmq";
import { prisma } from "@vault/db";
import { buildRedisConnection } from "../../src/lib/config/redis.js";
import { TEXT_QUEUE } from "../../src/queues/enqueueText.js";
import { OCR_QUEUE } from "../../src/queues/enqueueOcr.js";

const THUMB_QUEUE = process.env.THUMB_QUEUE ?? "thumb_queue";
const HASH_QUEUE = process.env.HASH_QUEUE ?? "hash_queue";

type Drain = "thumb" | "text" | "hash" | "all" | "none";

type Args = {
  label: string;
  scope: string;
  out: string;
  pids: number[];
  intervalMs: number;
  drain: Drain;
  maxSeconds: number;
  quiet: boolean;
};

function parseArgs (argv: string[]): Args {
  const a: Args = {
    label: "run", scope: "", out: "./bench-results", pids: [],
    intervalMs: 1000, drain: "all", maxSeconds: 3600, quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--label") a.label = argv[++i];
    else if (k === "--scope") a.scope = argv[++i];
    else if (k === "--out") a.out = argv[++i];
    else if (k === "--pids") a.pids = argv[++i].split(",").map(s => Number.parseInt(s.trim(), 10)).filter(Number.isFinite);
    else if (k === "--interval") a.intervalMs = Number.parseInt(argv[++i], 10);
    else if (k === "--drain") a.drain = argv[++i] as Drain;
    else if (k === "--max-seconds") a.maxSeconds = Number.parseInt(argv[++i], 10);
    else if (k === "--quiet") a.quiet = true;
    else throw new Error(`Unknown argument: ${k}`);
  }
  if (!a.scope) throw new Error("--scope <corpus root> is required (scopes the database counts)");
  return a;
}

// --- process counters ------------------------------------------------------

type ProcSample = {
  cpuPct: number; rssBytes: number;
  /** ocrmypdf/ffmpeg fan-out. OCR's memory lives here, not in the node worker's
   *  RSS, and it is what caps OCR_CONCURRENCY. */
  childCpuPct: number; childRssBytes: number; childCount: number;
  systemCpuPct: number; diskReadBps: number; diskWriteBps: number;
};

/** Matched by image name, not PID: spawned and reaped per job. */
const CHILD_PATTERNS = ["tesseract", "gswin64c", "gs", "python", "python3", "ffmpeg", "unpaper", "pngquant", "img2pdf", "qpdf"];

/**
 * One long-lived PowerShell loop emitting NDJSON.
 *
 * Not typeperf: it expands instance wildcards once at start, so tesseract
 * processes spawned later are invisible. Not a spawn per sample either — that
 * would cost more than the jobs being measured.
 */
class ProcessCounters {
  private child?: ChildProcess;
  private latest: ProcSample = {
    cpuPct: 0, rssBytes: 0, childCpuPct: 0, childRssBytes: 0, childCount: 0,
    systemCpuPct: 0, diskReadBps: 0, diskWriteBps: 0,
  };
  private buf = "";
  ready = false;

  constructor (private pids: number[], private intervalMs: number) {}

  start (): void {
    const names = ["node", ...CHILD_PATTERNS].join(",");
    const wanted = this.pids.length ? this.pids.join(",") : "-1";
    this.child = spawn("powershell", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", PS_SAMPLER,
    ], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, BENCH_NAMES: names, BENCH_PIDS: wanted, BENCH_INTERVAL_MS: String(this.intervalMs) },
    });
    this.child.stdout?.setEncoding("utf8");
    this.child.stdout?.on("data", chunk => this.onData(chunk as string));
    this.child.on("error", () => { /* counters unavailable; samples stay zero */ });
  }

  private onData (chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line.startsWith("{")) continue;
      try {
        const o = JSON.parse(line);
        this.latest = {
          cpuPct: o.cpu ?? 0,
          rssBytes: o.rss ?? 0,
          childCpuPct: o.childCpu ?? 0,
          childRssBytes: o.childRss ?? 0,
          childCount: o.childCount ?? 0,
          systemCpuPct: o.sysCpu ?? 0,
          diskReadBps: o.diskRead ?? 0,
          diskWriteBps: o.diskWrite ?? 0,
        };
        this.ready = true;
      } catch { /* partial line; the next one will do */ }
    }
  }

  read (): ProcSample { return this.latest; }

  stop (): void { this.child?.kill(); }
}

/**
 * CPU% is delta(cumulative processor time) / delta(wall clock), so 400% is four
 * saturated cores. A process first seen this tick reports no CPU (nothing to
 * subtract); its memory still counts, which is the number that caps OCR.
 */
const PS_SAMPLER = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$names = $env:BENCH_NAMES -split ','
$wanted = @{}
foreach ($p in ($env:BENCH_PIDS -split ',')) { $wanted[[int]$p] = $true }
$iv = [int]$env:BENCH_INTERVAL_MS
$prev = @{}
$prevTime = [DateTime]::UtcNow

while ($true) {
  Start-Sleep -Milliseconds $iv
  $now = [DateTime]::UtcNow
  $dt = ($now - $prevTime).TotalSeconds
  $prevTime = $now
  if ($dt -le 0) { continue }

  $cpu = 0.0; $rss = 0.0; $ccpu = 0.0; $crss = 0.0; $ccount = 0
  $seen = @{}
  foreach ($proc in (Get-Process -Name $names)) {
    $id = $proc.Id
    $tot = 0.0
    try { $tot = $proc.TotalProcessorTime.TotalSeconds } catch { continue }
    $seen[$id] = $tot
    $delta = 0.0
    if ($prev.ContainsKey($id)) { $delta = $tot - $prev[$id] }
    $pct = 0.0
    if ($delta -gt 0) { $pct = ($delta / $dt) * 100.0 }
    if ($wanted.ContainsKey($id)) {
      $cpu += $pct
      $rss += $proc.WorkingSet64
    } elseif ($proc.ProcessName -ne 'node') {
      # Non-node watch-list images are OCR/ffmpeg fan-out. Other node processes
      # (API, web dev server) are excluded on purpose.
      $ccpu += $pct
      $crss += $proc.WorkingSet64
      $ccount += 1
    }
  }
  $prev = $seen

  $sys = 0.0; $dr = 0.0; $dw = 0.0
  $c = Get-Counter -Counter '\Processor(_Total)\% Processor Time','\PhysicalDisk(_Total)\Disk Read Bytes/sec','\PhysicalDisk(_Total)\Disk Write Bytes/sec'
  if ($c) {
    foreach ($s in $c.CounterSamples) {
      if ($s.Path -like '*processor time*') { $sys = $s.CookedValue }
      elseif ($s.Path -like '*disk read bytes*') { $dr = $s.CookedValue }
      elseif ($s.Path -like '*disk write bytes*') { $dw = $s.CookedValue }
    }
  }

  $o = [ordered]@{
    cpu = [math]::Round($cpu, 2); rss = [long]$rss
    childCpu = [math]::Round($ccpu, 2); childRss = [long]$crss; childCount = $ccount
    sysCpu = [math]::Round($sys, 2); diskRead = [long]$dr; diskWrite = [long]$dw
  }
  Write-Output ($o | ConvertTo-Json -Compress)
}
`;

// --- database + queue sampling ---------------------------------------------

type DbCounts = {
  total: number;
  thumbPending: number; thumbDispatched: number; thumbDone: number; thumbFailed: number;
  textPending: number; textDispatched: number; textDone: number; textNeedsOcr: number; textError: number;
  hashed: number; unhashed: number;
};

type DbCountsRow = {
  total: number;
  thumb_pending: number; thumb_dispatched: number; thumb_done: number; thumb_failed: number;
  text_pending: number; text_dispatched: number; text_done: number; text_needs_ocr: number; text_error: number;
  hashed: number; unhashed: number;
};

/**
 * Scoped by sourcePath prefix so the dev library's unrelated rows don't offset
 * every "done" figure.
 *
 * `starts_with`, not LIKE: backslash is LIKE's default escape character, so
 * `LIKE 'E:\vault-bench\corpus%'` reads as `E:vault-benchcorpus%` and silently
 * matches nothing. Prisma's `startsWith` filter has the same problem. Any scope
 * filter on a Windows path must avoid LIKE.
 */
async function readDb (scopePrefix: string): Promise<DbCounts> {
  const [row] = await prisma.$queryRaw<DbCountsRow[]>`
    SELECT
      count(*)::int                                                                       AS total,
      count(*) FILTER (WHERE "thumbState" = 'PENDING')::int                               AS thumb_pending,
      count(*) FILTER (WHERE "thumbState" = 'PENDING' AND "thumbQueuedAt" IS NOT NULL)::int AS thumb_dispatched,
      count(*) FILTER (WHERE "thumbState" = 'READY')::int                                 AS thumb_done,
      count(*) FILTER (WHERE "thumbState" IN ('FAILED','ERROR'))::int                     AS thumb_failed,
      count(*) FILTER (WHERE "textState"  = 'PENDING')::int                               AS text_pending,
      count(*) FILTER (WHERE "textState"  = 'PENDING' AND "textQueuedAt" IS NOT NULL)::int  AS text_dispatched,
      count(*) FILTER (WHERE "textState"  = 'READY')::int                                 AS text_done,
      count(*) FILTER (WHERE "textState"  = 'NEEDS_OCR')::int                             AS text_needs_ocr,
      count(*) FILTER (WHERE "textState"  = 'ERROR')::int                                 AS text_error,
      count(*) FILTER (WHERE "contentHash" IS NOT NULL)::int                              AS hashed,
      count(*) FILTER (WHERE "contentHash" IS NULL)::int                                  AS unhashed
    FROM "Media"
    WHERE starts_with("sourcePath", ${scopePrefix})
  `;
  return {
    total: row.total,
    thumbPending: row.thumb_pending, thumbDispatched: row.thumb_dispatched,
    thumbDone: row.thumb_done, thumbFailed: row.thumb_failed,
    textPending: row.text_pending, textDispatched: row.text_dispatched,
    textDone: row.text_done, textNeedsOcr: row.text_needs_ocr, textError: row.text_error,
    hashed: row.hashed, unhashed: row.unhashed,
  };
}

type QueueCounts = Record<string, { waiting: number; active: number; delayed: number; failed: number }>;

async function readQueues (queues: Record<string, Queue>): Promise<QueueCounts> {
  const out: QueueCounts = {};
  await Promise.all(Object.entries(queues).map(async ([name, q]) => {
    const c = await q.getJobCounts("waiting", "active", "delayed", "failed", "prioritized");
    out[name] = {
      waiting: (c.waiting ?? 0) + (c.prioritized ?? 0),
      active: c.active ?? 0,
      delayed: c.delayed ?? 0,
      failed: c.failed ?? 0,
    };
  }));
  return out;
}

const CSV_HEADER = [
  "t_ms", "iso",
  "sys_cpu_pct", "worker_cpu_pct", "worker_rss_mb", "child_cpu_pct", "child_rss_mb", "child_count",
  "disk_read_mb_s", "disk_write_mb_s",
  "thumb_w", "thumb_a", "text_w", "text_a", "ocr_w", "ocr_a", "hash_w", "hash_a",
  "db_total", "thumb_pending", "thumb_dispatched", "thumb_done", "thumb_failed",
  "text_pending", "text_dispatched", "text_done", "text_needs_ocr", "text_error",
  "hashed", "unhashed",
].join(",");

/** Both halves must be quiet: an empty queue with rows still PENDING only means
 *  the feeder has not ticked yet. */
function isDrained (drain: Drain, db: DbCounts, q: QueueCounts): boolean {
  const quiet = (name: string) => (q[name]?.waiting ?? 0) === 0 && (q[name]?.active ?? 0) === 0;
  switch (drain) {
    case "none":  return false;
    case "thumb": return db.thumbPending === 0 && quiet("thumb");
    case "text":  return db.textPending === 0 && quiet("text");
    case "hash":  return db.unhashed === 0 && quiet("hash");
    case "all":
      return db.thumbPending === 0 && db.textPending === 0
        && quiet("thumb") && quiet("text") && quiet("hash");
  }
}

async function main () {
  const args = parseArgs(process.argv.slice(2));
  await mkdir(args.out, { recursive: true });
  const csvPath = path.join(args.out, `${args.label}.samples.csv`);
  const jsonPath = path.join(args.out, `${args.label}.summary.json`);
  await writeFile(csvPath, CSV_HEADER + "\n", "utf8");

  const connection = buildRedisConnection(process.env.REDIS_URL ?? "redis://localhost:6379");
  const queues: Record<string, Queue> = {
    thumb: new Queue(THUMB_QUEUE, { connection }),
    text: new Queue(TEXT_QUEUE, { connection }),
    ocr: new Queue(OCR_QUEUE, { connection }),
    hash: new Queue(HASH_QUEUE, { connection }),
  };

  const counters = new ProcessCounters(args.pids, Math.max(1, Math.round(args.intervalMs / 1000)));
  counters.start();

  const t0 = Date.now();
  const first = await readDb(args.scope);
  if (first.total === 0) throw new Error(`no rows under ${args.scope} — nothing to measure`);
  // Rows already terminal at t0 are not this run's work; rates come from deltas.
  const baseline = { thumbDone: first.thumbDone, textDone: first.textDone + first.textNeedsOcr, hashed: first.hashed };

  const samples: { t: number; cpu: number; rss: number; childCpu: number; childRss: number; childCount: number;
                   sysCpu: number; read: number; write: number;
                   thumbDone: number; textDone: number; hashed: number }[] = [];
  let drainedFor = 0;
  let stopping = false;
  process.on("SIGINT", () => { stopping = true; });

  if (!args.quiet) {
    console.log(`measuring "${args.label}"  scope=${args.scope}  pids=${args.pids.join(",") || "(none)"}`);
    console.log(`corpus rows: ${first.total}  thumb pending ${first.thumbPending}  text pending ${first.textPending}\n`);
  }

  for (;;) {
    const tick = Date.now();
    const [db, q] = await Promise.all([readDb(args.scope), readQueues(queues)]);
    const p = counters.read();
    const t = tick - t0;

    const thumbDone = db.thumbDone - baseline.thumbDone;
    // NEEDS_OCR is a completed tier-1 job, not an incomplete one.
    const textDone = db.textDone + db.textNeedsOcr - baseline.textDone;
    const hashed = db.hashed - baseline.hashed;

    samples.push({
      t, cpu: p.cpuPct, rss: p.rssBytes,
      childCpu: p.childCpuPct, childRss: p.childRssBytes, childCount: p.childCount,
      sysCpu: p.systemCpuPct, read: p.diskReadBps, write: p.diskWriteBps, thumbDone, textDone, hashed,
    });

    await appendFile(csvPath, [
      t, new Date(tick).toISOString(),
      p.systemCpuPct.toFixed(2), p.cpuPct.toFixed(2), (p.rssBytes / 1048576).toFixed(1),
      p.childCpuPct.toFixed(2), (p.childRssBytes / 1048576).toFixed(1), p.childCount,
      (p.diskReadBps / 1048576).toFixed(2), (p.diskWriteBps / 1048576).toFixed(2),
      q.thumb.waiting, q.thumb.active, q.text.waiting, q.text.active,
      q.ocr.waiting, q.ocr.active, q.hash.waiting, q.hash.active,
      db.total, db.thumbPending, db.thumbDispatched, db.thumbDone, db.thumbFailed,
      db.textPending, db.textDispatched, db.textDone, db.textNeedsOcr, db.textError,
      db.hashed, db.unhashed,
    ].join(",") + "\n", "utf8");

    if (!args.quiet) {
      process.stdout.write(
        `\r  ${(t / 1000).toFixed(0)}s  cpu ${p.cpuPct.toFixed(0)}% (sys ${p.systemCpuPct.toFixed(0)}%)  ` +
        `rss ${(p.rssBytes / 1048576).toFixed(0)}MB  read ${(p.diskReadBps / 1048576).toFixed(1)}MB/s  ` +
        `thumb ${db.thumbPending} left  text ${db.textPending} left     `,
      );
    }

    // Three consecutive: one empty queue between feeder batches is not the end.
    drainedFor = isDrained(args.drain, db, q) ? drainedFor + 1 : 0;
    if (drainedFor >= 3) break;
    if (stopping) break;
    if (t > args.maxSeconds * 1000) {
      if (!args.quiet) console.log(`\n  hit --max-seconds ${args.maxSeconds}; stopping`);
      break;
    }

    const spent = Date.now() - tick;
    await new Promise(r => setTimeout(r, Math.max(0, args.intervalMs - spent)));
  }

  counters.stop();
  const last = await readDb(args.scope);
  const elapsedMs = Date.now() - t0;

  // Drop samples taken before the counter loop produced its first rate.
  const warm = samples.filter(s => s.cpu > 0 || s.sysCpu > 0);
  const stat = (xs: number[]) => {
    if (xs.length === 0) return { mean: 0, max: 0, p95: 0 };
    const sorted = [...xs].sort((a, b) => a - b);
    return {
      mean: xs.reduce((a, b) => a + b, 0) / xs.length,
      max: sorted[sorted.length - 1],
      p95: sorted[Math.min(sorted.length - 1, Math.floor(xs.length * 0.95))],
    };
  };

  const completed = {
    thumb: last.thumbDone - baseline.thumbDone,
    text: last.textDone + last.textNeedsOcr - baseline.textDone,
    hash: last.hashed - baseline.hashed,
  };
  const seconds = elapsedMs / 1000;

  const summary = {
    label: args.label,
    startedAt: new Date(t0).toISOString(),
    elapsedSeconds: Number(seconds.toFixed(1)),
    drain: args.drain,
    pids: args.pids,
    corpusRows: last.total,
    completed,
    throughputPerSecond: {
      thumb: Number((completed.thumb / seconds).toFixed(2)),
      text: Number((completed.text / seconds).toFixed(2)),
      hash: Number((completed.hash / seconds).toFixed(2)),
    },
    workerCpuPct: stat(warm.map(s => s.cpu)),
    systemCpuPct: stat(warm.map(s => s.sysCpu)),
    workerRssMB: stat(warm.map(s => s.rss / 1048576)),
    childCpuPct: stat(warm.map(s => s.childCpu)),
    childRssMB: stat(warm.map(s => s.childRss / 1048576)),
    peakChildCount: warm.reduce((m, s) => Math.max(m, s.childCount), 0),
    diskReadMBps: stat(warm.map(s => s.read / 1048576)),
    diskWriteMBps: stat(warm.map(s => s.write / 1048576)),
    finalState: last,
    samples: samples.length,
    countersAvailable: counters.ready,
    // Recorded per run so results are never mistaken for NAS numbers.
    storageClass: process.env.BENCH_STORAGE_CLASS ?? "local-ssd (unlabelled)",
    concurrency: {
      TEXT_CONCURRENCY: process.env.TEXT_CONCURRENCY ?? null,
      OCR_CONCURRENCY: process.env.OCR_CONCURRENCY ?? null,
      THUMB_CONCURRENCY: process.env.THUMB_CONCURRENCY ?? null,
      HASH_CONCURRENCY: process.env.HASH_CONCURRENCY ?? null,
      SHARP_CONCURRENCY: process.env.SHARP_CONCURRENCY ?? null,
      LOW_MEMORY: process.env.LOW_MEMORY ?? null,
    },
  };
  await writeFile(jsonPath, JSON.stringify(summary, null, 2), "utf8");

  if (!args.quiet) {
    console.log(`\n\n${args.label}: ${seconds.toFixed(1)}s`);
    console.log(`  thumb ${completed.thumb} (${summary.throughputPerSecond.thumb}/s)  ` +
                `text ${completed.text} (${summary.throughputPerSecond.text}/s)  ` +
                `hash ${completed.hash} (${summary.throughputPerSecond.hash}/s)`);
    console.log(`  worker cpu mean ${summary.workerCpuPct.mean.toFixed(0)}% peak ${summary.workerCpuPct.max.toFixed(0)}%  ` +
                `rss peak ${summary.workerRssMB.max.toFixed(0)}MB`);
    if (summary.peakChildCount > 0) {
      console.log(`  subprocess cpu mean ${summary.childCpuPct.mean.toFixed(0)}% peak ${summary.childCpuPct.max.toFixed(0)}%  ` +
                  `rss peak ${summary.childRssMB.max.toFixed(0)}MB  peak count ${summary.peakChildCount}`);
    }
    console.log(`  disk read mean ${summary.diskReadMBps.mean.toFixed(1)} MB/s peak ${summary.diskReadMBps.max.toFixed(1)} MB/s`);
    if (last.thumbFailed || last.textError) {
      console.log(`  !! thumb FAILED ${last.thumbFailed}  text ERROR ${last.textError}`);
    }
    console.log(`  → ${csvPath}`);
  }

  await Promise.allSettled(Object.values(queues).map(q => q.close()));
}

main()
  .catch(err => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
