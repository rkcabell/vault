import test from "node:test";
import assert from "node:assert/strict";
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
  const indexQueue = {
    getJobs: async () => jobs,
    getJob: async (id: string) => jobs.find(j => j.id === id) ?? null,
  } as any;
  return createIndexService({ indexQueue, logger: makeLogger() });
}

test("getActive returns this user's in-flight scan", async () => {
  const svc = makeService([
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
  const svc = makeService([
    makeJob("index-u2-Zm9v", { scanned: 5, indexed: 5, skipped: 0, filtered: 0 }),
  ]);

  assert.equal(await svc.getActive("u1"), null);
});

test("getActive returns null when no scan is running", async () => {
  const svc = makeService([]);
  assert.equal(await svc.getActive("u1"), null);
});
