import test from "node:test";
import assert from "node:assert/strict";
import { createDeleteJobService } from "@/services/media/deleteJobService.js";

function makeLogger () {
  return { info: () => {} };
}

function makeJob (id: string, over: { state?: string; progress?: object; returnvalue?: object; timestamp?: number } = {}) {
  return {
    id,
    timestamp: over.timestamp ?? 0,
    progress: over.progress ?? {},
    returnvalue: over.returnvalue ?? null,
    getState: async () => over.state ?? "active",
  };
}

function makeQueue (over: {
  getJob?: (id: string) => Promise<unknown>;
  getJobs?: (states: string[]) => Promise<unknown[]>;
} = {}) {
  const added: { name: string; data: unknown; opts: { jobId: string } }[] = [];
  const queue = {
    add: async (name: string, data: unknown, opts: { jobId: string }) => { added.push({ name, data, opts }); },
    getJob: over.getJob ?? (async () => null),
    getJobs: over.getJobs ?? (async () => []),
  } as any;
  return { queue, added };
}

test("startDelete enqueues a job whose id is owned by the user", async () => {
  const { queue, added } = makeQueue();
  const svc = createDeleteJobService({ deleteQueue: queue, logger: makeLogger() });

  const { jobId } = await svc.startDelete("u1", { ids: ["a", "b"] });

  assert.equal(added.length, 1);
  assert.ok(jobId.startsWith("delete-u1-"));
  assert.equal(added[0].opts.jobId, jobId);
  assert.deepEqual((added[0].data as { ids: string[] }).ids, ["a", "b"]);
});

test("getStatus rejects a job id that isn't the caller's (no queue hit)", async () => {
  let hit = false;
  const { queue } = makeQueue({ getJob: async () => { hit = true; return makeJob("delete-u2-1"); } });
  const svc = createDeleteJobService({ deleteQueue: queue, logger: makeLogger() });

  const status = await svc.getStatus("u1", "delete-u2-1");

  assert.equal(status, null);
  assert.equal(hit, false, "must not look up another user's job");
});

test("getStatus maps the final returnvalue counts", async () => {
  const job = makeJob("delete-u1-1", {
    state: "completed",
    returnvalue: { total: 10, deleted: 9, failed: 1, aborted: false },
  });
  const { queue } = makeQueue({ getJob: async () => job });
  const svc = createDeleteJobService({ deleteQueue: queue, logger: makeLogger() });

  const status = await svc.getStatus("u1", "delete-u1-1");

  assert.deepEqual(status, {
    jobId: "delete-u1-1", state: "completed", done: true, aborted: false,
    total: 10, deleted: 9, failed: 1,
  });
});

test("getActive returns the most recent of the user's in-flight jobs", async () => {
  const jobs = [
    makeJob("delete-u1-1", { timestamp: 100, progress: { total: 5, deleted: 1, failed: 0 } }),
    makeJob("delete-u2-9", { timestamp: 200 }),
    makeJob("delete-u1-2", { timestamp: 300, progress: { total: 8, deleted: 2, failed: 0 } }),
  ];
  const { queue } = makeQueue({ getJobs: async () => jobs });
  const svc = createDeleteJobService({ deleteQueue: queue, logger: makeLogger() });

  const status = await svc.getActive("u1");

  assert.equal(status?.jobId, "delete-u1-2"); // newest of u1's jobs
  assert.equal(status?.total, 8);
});

test("abort bumps the redis epoch when redis is wired", async () => {
  let incremented = 0;
  const { queue } = makeQueue();
  const svc = createDeleteJobService({
    deleteQueue: queue,
    logger: makeLogger(),
    redis: { incr: async () => ++incremented },
  });

  const result = await svc.abort();

  assert.deepEqual(result, { epoch: 1 });
  assert.equal(incremented, 1);
});

test("abort is a no-op when redis isn't available", async () => {
  const { queue } = makeQueue();
  const svc = createDeleteJobService({ deleteQueue: queue, logger: makeLogger() });

  assert.equal(await svc.abort(), null);
});
