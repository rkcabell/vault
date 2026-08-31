import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createIndexService } from "@/services/media/indexService.js";

function makeLogger () {
  return { info: () => {} };
}

// A fake BullMQ job carrying just what toStatus reads.
function makeJob (id: string, progress: object) {
  return {
    id,
    progress,
    returnvalue: null,
    getState: async () => "active",
  };
}

function makeService (jobs: ReturnType<typeof makeJob>[]) {
  const added: { jobId: string }[] = [];
  const indexQueue = {
    getJobs: async () => jobs,
    getJob: async (id: string) => jobs.find(j => j.id === id) ?? null,
    add: async (_name: string, _data: unknown, opts: { jobId: string }) => {
      added.push({ jobId: opts.jobId });
      return { id: opts.jobId };
    },
  } as any;
  return { svc: createIndexService({ indexQueue, logger: makeLogger() }), added };
}

const START_INPUT = {
  recursive: true,
  ignoreHidden: true,
  blacklistExtensions: [],
  excludeFolders: [],
  skipNonContent: true,
};

/** startIndex stats the path, so the root has to exist for real. */
async function withRoot (fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "vault-index-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("getActive returns this user's in-flight scan", async () => {
  const { svc } = makeService([
    makeJob("index-u1-Zm9v", { scanned: 10, indexed: 7, skipped: 1, filtered: 2 }),
  ]);

  const status = await svc.getActive("u1");

  assert.ok(status);
  assert.equal(status!.jobId, "index-u1-Zm9v");
  assert.equal(status!.scanned, 10);
  assert.equal(status!.indexed, 7);
  assert.equal(status!.filtered, 2);
  assert.equal(status!.done, false);
});

test("getActive ignores jobs belonging to other users", async () => {
  const { svc } = makeService([
    makeJob("index-u2-Zm9v", { scanned: 5, indexed: 5, skipped: 0, filtered: 0 }),
  ]);

  assert.equal(await svc.getActive("u1"), null);
});

test("getActive returns null when no scan is running", async () => {
  const { svc } = makeService([]);
  assert.equal(await svc.getActive("u1"), null);
});

test("startIndex enqueues one walk when nothing is running", async () => {
  await withRoot(async root => {
    const { svc, added } = makeService([]);

    const result = await svc.startIndex("u1", { ...START_INPUT, path: root }, [root]);

    assert.equal(result.ok, true);
    assert.equal(added.length, 1);
  });
});

test("a second scan is refused while the user already has one in flight", async () => {
  await withRoot(async root => {
    // The in-flight job is on a *different* root: enqueueIndex's per-root jobId
    // would happily accept this one, so only the concurrency cap can stop it.
    const { svc, added } = makeService([
      makeJob("index-u1-b3RoZXI", { scanned: 1, indexed: 0, skipped: 0, filtered: 0 }),
    ]);

    const result = await svc.startIndex("u1", { ...START_INPUT, path: root }, [root]);

    assert.deepEqual(result, { ok: false, reason: "already_running" });
    assert.equal(added.length, 0);
  });
});

test("another user's scan does not block mine", async () => {
  await withRoot(async root => {
    const { svc, added } = makeService([
      makeJob("index-u2-b3RoZXI", { scanned: 1, indexed: 0, skipped: 0, filtered: 0 }),
    ]);

    const result = await svc.startIndex("u1", { ...START_INPUT, path: root }, [root]);

    assert.equal(result.ok, true);
    assert.equal(added.length, 1);
  });
});
