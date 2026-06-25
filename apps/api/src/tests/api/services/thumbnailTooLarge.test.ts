import test from "node:test";
import assert from "node:assert/strict";
import { processThumb, type ThumbDeps } from "@/services/thumb/thumbnailService.js";
import { THUMBNAIL_TOO_LARGE_REASON, MAX_THUMBNAIL_BYTES } from "@/lib/media/processingSupport.js";

function makeLogger () {
  return { info: () => {}, warn: () => {}, error: () => {} } as any;
}

/** Records the terminal state writes; throws if any storage I/O is attempted, so
 *  the test proves the guard short-circuits before reading the (huge) source. */
function makeDeps (sizeBytes: number | null) {
  const calls = { failed: [] as { id: string; reason: string }[], published: [] as string[], readyCalls: 0 };

  const prismaMedia = {
    findThumbInfo: async () => ({
      thumbnailKey: null,
      thumbState: "PENDING",
      mimeType: "video/mp4",
      sourcePath: "/drive/huge.mp4",
      sizeBytes,
    }),
    setThumbFailed: async (id: string, reason: string) => { calls.failed.push({ id, reason }); },
    setThumbReady: async () => { calls.readyCalls++; },
  };

  const storage = {
    getObjectStream: async () => { throw new Error("storage must not be touched for an oversize file"); },
    objectExists: async () => { throw new Error("storage must not be touched for an oversize file"); },
  };

  const deps = {
    prismaMedia,
    storage,
    bucket: "b",
    logger: makeLogger(),
    queueName: "thumb_queue",
    publishJobUpdate: (u: { value: string }) => { calls.published.push(u.value); },
  } as unknown as ThumbDeps;

  return { deps, calls };
}

function job () {
  return { mediaId: "m1", userId: "u1", storageKey: "k", size: 512 } as any;
}

test("processThumb skips a file over 2 GiB: marks FAILED with the too-large reason, no storage I/O", async () => {
  const { deps, calls } = makeDeps(MAX_THUMBNAIL_BYTES + 1);

  await processThumb(deps, job()); // must not throw

  assert.deepEqual(calls.failed, [{ id: "m1", reason: THUMBNAIL_TOO_LARGE_REASON }]);
  assert.deepEqual(calls.published, ["FAILED"]);
  assert.equal(calls.readyCalls, 0);
});
