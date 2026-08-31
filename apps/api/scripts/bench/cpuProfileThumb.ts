/**
 * CPU profile for work item 15F's runbook step 1: confirm that
 * `renderPdfThumbnail.ts`'s `disableWorker: true` (pdf.js running on Node's main
 * thread) is really what pins the thumb worker at ~160% CPU regardless of
 * THUMB_CONCURRENCY.
 *
 * Same lifecycle as sweep.ts (real feeder, real worker, obliterate-then-drain),
 * but the worker is spawned with --cpu-prof instead of being timed, and the run
 * is a fixed wall-clock window rather than a full drain.
 *
 *   tsx scripts/bench/cpuProfileThumb.ts --scope E:/vault-bench/corpus --concurrency 4 --seconds 150
 */

import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
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

type Args = { scope: string; concurrency: number; seconds: number; out: string };

function parseArgs (argv: string[]): Args {
  const a: Args = { scope: "", concurrency: 4, seconds: 150, out: "./bench-results" };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--scope") a.scope = argv[++i];
    else if (k === "--concurrency") a.concurrency = Number.parseInt(argv[++i], 10);
    else if (k === "--seconds") a.seconds = Number.parseInt(argv[++i], 10);
    else if (k === "--out") a.out = argv[++i];
    else throw new Error(`Unknown argument: ${k}`);
  }
  if (!a.scope) throw new Error("--scope <corpus root> is required");
  return a;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function runScript (script: string, args: string[]): Promise<void> {
  const child = spawn(process.execPath, ["--import", "tsx", path.join(HERE, script), ...args], {
    cwd: API_ROOT, stdio: "inherit", env: process.env,
  });
  const [code] = await once(child, "exit") as [number | null];
  if (code !== 0) throw new Error(`${script} exited ${code}`);
}

async function main () {
  const args = parseArgs(process.argv.slice(2));
  await mkdir(args.out, { recursive: true });

  const connection = buildRedisConnection(process.env.REDIS_URL ?? "redis://localhost:6379");
  const thumbQueue = new Queue(THUMB_QUEUE, { connection });
  const textQueue = new Queue(TEXT_QUEUE, { connection });
  const repository = new MediaRepository(prisma);
  const preferences = new PreferencesService(new PreferencesRepository(prisma));

  if (await readLowMemoryPreference(prisma)) {
    throw new Error("lowMemoryMode is enabled in preferences - turn it off before profiling.");
  }

  console.log(`resetting thumb state under ${args.scope}...`);
  await runScript("resetDerivatives.ts", ["--scope", args.scope, "--kind", "thumb"]);
  await thumbQueue.obliterate({ force: true });

  const label = `thumb-cpuprof-c${args.concurrency}`;
  console.log(`\nstarting thumb worker at THUMB_CONCURRENCY=${args.concurrency}, profiling for ${args.seconds}s`);

  const child = spawn(process.execPath, [
    "--cpu-prof", "--cpu-prof-dir", path.resolve(args.out), "--cpu-prof-name", `${label}.cpuprofile`,
    "--import", "tsx", path.join(API_ROOT, "src/worker/thumb.ts"),
  ], {
    cwd: API_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, THUMB_CONCURRENCY: String(args.concurrency) },
  });
  let ready = false;
  const log: string[] = [];
  const onChunk = (b: Buffer) => {
    const s = b.toString();
    log.push(s);
    process.stdout.write(s);
    if (s.includes("worker ready") || s.includes("worker started")) ready = true;
  };
  child.stdout?.on("data", onChunk);
  child.stderr?.on("data", onChunk);

  const readyDeadline = Date.now() + 60_000;
  while (!ready && Date.now() < readyDeadline) {
    if (child.exitCode !== null) throw new Error(`worker exited early (${child.exitCode}):\n${log.join("").slice(-2000)}`);
    await sleep(200);
  }
  if (!ready) throw new Error(`worker did not report ready in 60s:\n${log.join("").slice(-2000)}`);
  console.log(`worker pid ${child.pid} ready; profiling...`);

  const feeder = createDerivativeFeeder({
    repository, thumbQueue, textQueue,
    getAllowedRoots: async userId => (await preferences.getPreferences(userId)).indexAllowedRoots ?? [],
    logger: { info: () => {}, error: (o, m) => console.error(m, o) },
  });
  feeder.start();

  const t0 = Date.now();
  while (Date.now() - t0 < args.seconds * 1000) {
    await sleep(5000);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
    process.stdout.write(`\r  ${elapsed}s / ${args.seconds}s elapsed   `);
  }
  console.log("\nstopping feeder and worker (SIGTERM, so --cpu-prof flushes on a clean exit)...");

  await feeder.stop();

  // Same pattern as sweep.ts's stopWorker: SIGTERM and wait, SIGKILL only as a
  // last resort — a SIGKILL here would drop the .cpuprofile entirely.
  child.kill("SIGTERM");
  const deadline = Date.now() + 30_000;
  while (child.exitCode === null && Date.now() < deadline) await sleep(300);
  if (child.exitCode === null) {
    console.error("worker did not exit within 30s of SIGTERM - killing; .cpuprofile will be lost");
    child.kill("SIGKILL");
  } else {
    console.log(`worker exited cleanly (code ${child.exitCode}) - profile should be at ${path.join(args.out, `${label}.cpuprofile`)}`);
  }

  await Promise.allSettled([thumbQueue.close(), textQueue.close()]);
}

main()
  .catch(err => { console.error(`\ncpuProfileThumb failed: ${err instanceof Error ? err.message : err}`); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
