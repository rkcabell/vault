import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import type { Job } from "bullmq";
import { createHashProcessor } from "@/worker/hashWorker.js";
import type { HashJobData } from "@/queues/enqueueHash.js";

// sha256("hello world")
const HELLO_WORLD_SHA256 = "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";

function makeLogger () {
  return { info: () => {}, warn: () => {} };
}

function makeDeps (opts: {
  chunks?: string[] | null;
  detectDuplicates?: boolean;
  duplicateId?: string | null;
} = {}) {
  const hashes: Array<{ mediaId: string; hash: string }> = [];
  const tagged: string[] = [];
  const states: Array<{ mediaId: string; state: "READY" | "FAILED" }> = [];

  const deps = {
    mediaRepository: {
      setContentHash: async (mediaId: string, hash: string) => { hashes.push({ mediaId, hash }); },
      setHashState: async (mediaId: string, state: "READY" | "FAILED") => { states.push({ mediaId, state }); return true; },
      findDuplicateByHash: async () => (opts.duplicateId ? { id: opts.duplicateId } : null),
      addTagIfAbsent: async (mediaId: string, tagName: string) => { tagged.push(`${mediaId}:${tagName}`); },
    },
    preferencesService: {
      getPreferences: async () => ({ detectDuplicates: opts.detectDuplicates ?? false }),
    },
    storage: {
      getObjectStream: async () =>
        opts.chunks === null
          ? null
          : { body: Readable.from(opts.chunks ?? ["hello ", "world"]), etag: null, contentLength: 11, totalLength: 11 },
    } as never,
    bucket: "vault",
    logger: makeLogger(),
  };

  return { deps, hashes, tagged, states };
}

function makeJob (data: Partial<HashJobData> = {}) {
  return {
    data: {
      type: "hash",
      mediaId: "m1",
      userId: "u1",
      storageKey: "u1/m1/file.bin",
      ...data,
    },
  } as unknown as Job<HashJobData>;
}

test("hash: streams the source into sha256, persists the digest, and marks READY", async () => {
  const t = makeDeps({ chunks: ["hello ", "world"] });

  await createHashProcessor(t.deps)(makeJob(), "tok");

  assert.deepEqual(t.hashes, [{ mediaId: "m1", hash: HELLO_WORLD_SHA256 }]);
  assert.deepEqual(t.states, [{ mediaId: "m1", state: "READY" }]);
  assert.deepEqual(t.tagged, []); // detectDuplicates off → never tags
});

test("hash: tags both copies when detectDuplicates finds a match", async () => {
  const t = makeDeps({ detectDuplicates: true, duplicateId: "m0" });

  await createHashProcessor(t.deps)(makeJob(), "tok");

  assert.deepEqual(t.tagged.sort(), ["m0:duplicate", "m1:duplicate"]);
});

test("hash: missing source is marked FAILED without throwing (retrying won't conjure it back)", async () => {
  const t = makeDeps({ chunks: null });

  await createHashProcessor(t.deps)(makeJob(), "tok");

  assert.deepEqual(t.hashes, []);
  assert.deepEqual(t.states, [{ mediaId: "m1", state: "FAILED" }]);
  assert.deepEqual(t.tagged, []);
});
