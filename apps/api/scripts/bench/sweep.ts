/**
 * Concurrency sweep for work item 15F.
 *
 * Runs one corpus through one derivative queue at a series of concurrency
 * settings. Three things shape it:
 *
 *  - One queue per run. With thumb, text and hash all live no CPU number can be
 *    attributed, and the question is per-queue anyway.
 *  - The API must be stopped; this starts the real feeder itself. Two feeders on
 *    one queue is harmless (SKIP LOCKED) but silently doubles the bound.
 *  - Workers are spawned as bare `node --import tsx`, not via pnpm, so child.pid
 *    is the process being measured rather than a shell.
 *
 *   tsx scripts/bench/sweep.ts --scope E:/corpus --queue thumb --values 2,4,8,16
 */

import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { Queue } from "bullmq";
import { prisma } from "@vault/db";
import { MediaRepository } from "../../src/repositories/mediaRepository.js";
import { PreferencesRepository } from "../../src/repositories/preferencesRepository.js";
import { PreferencesService } from "../../src/services/preferencesService.js";
import { createDerivativeFeeder } from "../../src/services/media/derivativeFeeder.js";
import { buildRedisConnection } from "../../src/lib/config/redis.js";
import { readLowMemoryPreference } from "../../src/worker/workerPrefs.js";
import { TEXT_QUEUE } from "../../src/queues/enqueueText.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API_ROOT = path.resolve(HERE, "../..");
const THUMB_QUEUE = process.env.THUMB_QUEUE ?? "thumb_queue";

type QueueKind = "thumb" | "text";

type Args = {
  scope: string;
  queue: QueueKind;
  values: number[];
  out: string;
  storageClass: string;
  maxSeconds: number;
  settleSeconds: number;
};

function parseArgs (argv: string[]): Args {
  const a: Args = {
    scope: "", queue: "thumb", values: [], out: "./bench-results",
    storageClass: process.env.BENCH_STORAGE_CLASS ?? "local-ssd (unlabelled)",
    maxSeconds: 1800, settleSeconds: 5,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--scope") a.scope = argv[++i];
    else if (k === "--queue") a.queue = argv[++i] as QueueKind;
    else if (k === "--values") a.values = argv[++i].split(",").map(s => Number.parseInt(s.trim(), 10)).filter(Number.isFinite);
    else if (k === "--out") a.out = argv[++i];
    else if (k === "--storage-class") a.storageClass = argv[++i];
    else if (k === "--max-seconds") a.maxSeconds = Number.parseInt(argv[++i], 10);
    else if (k === "--settle-seconds") a.settleSeconds = Number.parseInt(argv[++i], 10);
    else throw new Error(`Unknown argument: ${k}`);
  }
  if (!a.scope) throw new Error("--scope <corpus root> is required");
  if (a.values.length === 0) throw new Error("--values 2,4,8 is required");
  if (a.queue !== "thumb" && a.queue !== "text") throw new Error("--queue must be thumb or text");
  return a;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Run a bench script to completion, inheriting stdio. */
async function runScript (script: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<void> {
  const child = spawn(process.execPath, ["--import", "tsx", path.join(HERE, script), ...args], {
    cwd: API_ROOT,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  const [code] = await once(child, "exit") as [number | null];
  if (code !== 0) throw new Error(`${script} exited ${code}`);
}

/** Waits on the ready log line, not a fixed sleep: the thumb worker awaits
 *  configureSharp first, and jobs run before t0 are timed by nobody. */
async function startWorker (entry: string, env: NodeJS.ProcessEnv, log: string[]): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["--import", "tsx", path.join(API_ROOT, "src/worker", entry)], {
    cwd: API_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  let ready = false;
  const onChunk = (b: Buffer) => {
    const s = b.toString();
    log.push(s);
    if (s.includes("worker ready") || s.includes("worker started")) ready = true;
  };
  child.stdout?.on("data", onChunk);
  child.stderr?.on("data", onChunk);

  const deadline = Date.now() + 60_000;
  while (!ready && Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`worker exited early (${child.exitCode}):\n${log.join("").slice(-2000)}`);
    await sleep(200);
  }
  if (!ready) throw new Error(`worker did not report ready in 60s:\n${log.join("").slice(-2000)}`);
  return child;
}

async function stopWorker (child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  // Workers close their BullMQ connections on SIGTERM. A lock still held at
  // SIGKILL gets the job redelivered, corrupting the next run's counts.
  const deadline = Date.now() + 20_000;
  while (child.exitCode === null && Date.now() < deadline) await sleep(200);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function main () {
  const args = parseArgs(process.argv.slice(2));
  await mkdir(args.out, { recursive: true });

  const connection = buildRedisConnection(process.env.REDIS_URL ?? "redis://localhost:6379");
  const thumbQueue = new Queue(THUMB_QUEUE, { connection });
  const textQueue = new Queue(TEXT_QUEUE, { connection });
  const repository = new MediaRepository(prisma);
  const preferences = new PreferencesService(new PreferencesRepository(prisma));

  // starts_with, not Prisma's startsWith: that compiles to LIKE, where backslash
  // is the escape character and a Windows path prefix matches nothing.
  const [{ n }] = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM "Media" WHERE starts_with("sourcePath", ${args.scope})
  `;
  const total = Number(n);
  if (total === 0) throw new Error(`no indexed rows under ${args.scope} - index the corpus first`);

  // LOW_MEMORY cannot be turned off from the environment - the workers fall
  // through to the DB preference unless env is exactly "true"/"1" - and if it is
  // on, every concurrency under test is silently halved.
  if (await readLowMemoryPreference(prisma)) {
    throw new Error(
      "lowMemoryMode is enabled in preferences, which halves every concurrency. " +
      "Turn it off before sweeping - LOW_MEMORY=false does not override it.",
    );
  }

  console.log(`sweep: ${args.queue}_queue over ${total} rows`);
  console.log(`values: ${args.values.join(", ")}`);
  console.log(`storage class: ${args.storageClass}\n`);

  const entry = args.queue === "thumb" ? "thumb.ts" : "text.ts";
  const envVar = args.queue === "thumb" ? "THUMB_CONCURRENCY" : "TEXT_CONCURRENCY";
  /** Only the summary fields the comparison table reads. */
  type RunSummary = {
    /** The value under test on this run. Deliberately not named `concurrency`:
     *  measure.ts writes a `concurrency` key of its own — the full env snapshot,
     *  for provenance — and it used to overwrite this one through the spread
     *  below, so every run recorded an object where the curve's x-axis belongs. */
    concurrencyUnderTest: number;
    elapsedSeconds: number;
    completed: Record<string, number>;
    throughputPerSecond: Record<string, number>;
    workerCpuPct: { mean: number; max: number };
    workerRssMB: { mean: number; max: number };
    childRssMB?: { mean: number; max: number };
    diskReadMBps: { mean: number; max: number };
    systemCpuPct: { mean: number; max: number };
    finalState: { thumbFailed: number; textError: number };
  };
  const results: RunSummary[] = [];

  for (const value of args.values) {
    const label = `${args.queue}-c${value}`;
    console.log(`\n${"=".repeat(64)}\n${label}\n${"=".repeat(64)}`);

    // Only the queue under test, so an undrained queue's Redis work stays out
    // of the measurement.
    await runScript("resetDerivatives.ts", ["--scope", args.scope, "--kind", args.queue]);

    // Jobs key on the media id and BullMQ silently drops an add for an id that
    // still exists, so a stale job would leave its row dispatched forever.
    // Destructive: wipes the whole queue, hence the API must be stopped.
    const q = args.queue === "thumb" ? thumbQueue : textQueue;
    await q.obliterate({ force: true });

    const log: string[] = [];
    const worker = await startWorker(entry, {
      [envVar]: String(value),
      BENCH_STORAGE_CLASS: args.storageClass,
    }, log);
    console.log(`  worker pid ${worker.pid}, ${envVar}=${value}`);

    // The real feeder, water marks at their defaults.
    const feeder = createDerivativeFeeder({
      repository,
      thumbQueue,
      textQueue,
      getAllowedRoots: async userId => (await preferences.getPreferences(userId)).indexAllowedRoots ?? [],
      logger: { info: () => {}, error: (o, m) => console.error(m, o) },
    });
    feeder.start();

    const measure = spawn(process.execPath, [
      "--import", "tsx", path.join(HERE, "measure.ts"),
      "--label", label, "--scope", args.scope, "--out", args.out,
      "--pids", String(worker.pid), "--drain", args.queue,
      "--max-seconds", String(args.maxSeconds),
    ], {
      cwd: API_ROOT,
      stdio: "inherit",
      env: { ...process.env, [envVar]: String(value), BENCH_STORAGE_CLASS: args.storageClass, LOW_MEMORY: "false" },
    });
    const [code] = await once(measure, "exit") as [number | null];

    await feeder.stop();
    await stopWorker(worker);
    if (code !== 0) throw new Error(`measure exited ${code} for ${label}`);

    const summary = JSON.parse(await readFile(path.join(args.out, `${label}.summary.json`), "utf8")) as Omit<RunSummary, "concurrencyUnderTest">;
    results.push({ ...summary, concurrencyUnderTest: value });

    // So run N+1 does not start inside run N's tail.
    await sleep(args.settleSeconds * 1000);
  }

  const comparison = {
    queue: args.queue,
    scope: args.scope,
    storageClass: args.storageClass,
    corpusRows: total,
    generatedAt: new Date().toISOString(),
    runs: results.map(r => ({
      concurrency: r.concurrencyUnderTest,
      elapsedSeconds: r.elapsedSeconds,
      completed: r.completed[args.queue],
      itemsPerSecond: r.throughputPerSecond[args.queue],
      workerCpuMeanPct: Number(r.workerCpuPct.mean.toFixed(1)),
      workerCpuPeakPct: Number(r.workerCpuPct.max.toFixed(1)),
      workerRssPeakMB: Number(r.workerRssMB.max.toFixed(0)),
      childRssPeakMB: Number((r.childRssMB?.max ?? 0).toFixed(0)),
      diskReadMeanMBps: Number(r.diskReadMBps.mean.toFixed(1)),
      diskReadPeakMBps: Number(r.diskReadMBps.max.toFixed(1)),
      systemCpuMeanPct: Number(r.systemCpuPct.mean.toFixed(1)),
      failures: args.queue === "thumb" ? r.finalState.thumbFailed : r.finalState.textError,
    })),
  };
  const outFile = path.join(args.out, `sweep-${args.queue}.json`);
  await writeFile(outFile, JSON.stringify(comparison, null, 2), "utf8");

  console.log(`\n\n${"=".repeat(78)}`);
  console.log(`${args.queue}_queue — ${total} rows — ${args.storageClass}`);
  console.log("=".repeat(78));
  console.log(
    "conc".padStart(5) + "items".padStart(8) + "sec".padStart(9) + "items/s".padStart(10) +
    "cpu%".padStart(8) + "peakRSS".padStart(9) + "readMB/s".padStart(10) + "fail".padStart(6),
  );
  for (const r of comparison.runs) {
    console.log(
      String(r.concurrency).padStart(5) +
      String(r.completed).padStart(8) +
      r.elapsedSeconds.toFixed(1).padStart(9) +
      r.itemsPerSecond.toFixed(2).padStart(10) +
      r.workerCpuMeanPct.toFixed(0).padStart(8) +
      `${r.workerRssPeakMB}MB`.padStart(9) +
      r.diskReadMeanMBps.toFixed(1).padStart(10) +
      String(r.failures).padStart(6),
    );
  }
  const best = [...comparison.runs].sort((a, b) => b.itemsPerSecond - a.itemsPerSecond)[0];
  console.log(`\nfastest: concurrency ${best.concurrency} at ${best.itemsPerSecond} items/s`);
  console.log(`→ ${outFile}`);

  await Promise.allSettled([thumbQueue.close(), textQueue.close()]);
}

main()
  .catch(err => { console.error(`\nsweep failed: ${err instanceof Error ? err.message : err}`); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
