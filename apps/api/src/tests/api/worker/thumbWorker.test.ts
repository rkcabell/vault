//File: apps/api/src/tests/api/worker/thumbWorker.test.ts

import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import sharp from "sharp";
import { prisma } from "@vault/db";
import { processThumb, type ThumbDeps } from "@/worker/thumbWorker.js";
import type { StorageAdapter } from "@/adapters/storage/types.js";

process.env.NODE_ENV = "test";
process.env.STORAGE_BUCKET = "test-bucket";
process.env.REDIS_URL = "redis://localhost:6379";
process.env.THUMB_QUEUE = "thumb:queue";

const originalFindUnique = prisma.media.findUnique.bind(prisma.media);
const originalUpdateMany = prisma.media.updateMany.bind(prisma.media);

function mockUpdate (fn: (args: any) => any) {
  (prisma.media as any).updateMany = async (args: any) => fn(args);
}

function mockFindUnique (result: any) {
  (prisma.media as any).findUnique = async () => result;
}

/** Fake storage: serves `source` on read (null = missing), records calls. */
function fakeStorage (source: Buffer | null): { storage: StorageAdapter; calls: string[] } {
  const calls: string[] = [];
  const storage = {
    getObjectStream: async () => {
      calls.push("get");
      if (source === null) return null;
      return { body: Readable.from(source), etag: null, contentLength: source.length, totalLength: source.length };
    },
    putObject: async () => { calls.push("put"); },
    deleteIfPresent: async () => {},
    objectExists: async () => source !== null,
    presignPut: async () => "/api/storage/blob/x",
    presignGet: async () => "/api/storage/blob/x",
    usage: async () => ({ sizeBytes: 0, objectCount: 0 }),
  } as unknown as StorageAdapter;
  return { storage, calls };
}

function mockThumbDeps (storage: StorageAdapter): ThumbDeps {
  return {
    prisma,
    storage,
    bucket: "test-bucket",
  };
}

afterEach(() => {
  (prisma.media as any).findUnique = originalFindUnique;
  (prisma.media as any).updateMany = originalUpdateMany;
});

test("processThumb marks READY when thumbnail already exists", async () => {
  const outKey = "thumbs/media-1.webp";

  mockFindUnique({ thumbnailKey: outKey, thumbState: "PENDING" });

  let updateArgs: unknown = null;
  mockUpdate((args: any) => {
    updateArgs = args;
    return { count: 1 };
  });

  const { storage, calls } = fakeStorage(null);
  await processThumb(mockThumbDeps(storage), {
    type: "thumb",
    mediaId: "media-1",
    userId: "user-1",
    storageKey: "originals/media-1.png",
    outKey,
    size: 128,
  });

  assert.equal(calls.length, 0); // no storage traffic when already READY
  assert.deepEqual((updateArgs as { data: unknown }).data, {
    thumbnailKey: outKey,
    thumbState: "READY",
    thumbError: null,
  });
});

test("processThumb uploads a thumbnail and updates the record", async () => {
  const imageBuffer = await sharp({
    create: {
      width: 1,
      height: 1,
      channels: 3,
      background: { r: 255, g: 0, b: 0 },
    },
  })
    .png()
    .toBuffer();

  mockFindUnique({ thumbnailKey: null, thumbState: "PENDING" });

  let updateArgs: unknown = null;
  mockUpdate((args: any) => {
    updateArgs = args;
    return { count: 1 };
  });

  const { storage, calls } = fakeStorage(imageBuffer);
  await processThumb(mockThumbDeps(storage), {
    type: "thumb",
    mediaId: "media-2",
    userId: "user-2",
    storageKey: "originals/media-2.png",
    outKey: "thumbs/media-2.webp",
    size: 256,
  });

  assert.ok(calls.includes("get"));
  assert.ok(calls.includes("put"));
  assert.deepEqual((updateArgs as { data: unknown }).data, {
    thumbnailKey: "thumbs/media-2.webp",
    thumbState: "READY",
    thumbError: null,
  });
});

test("processThumb marks FAILED when input cannot be decoded", async () => {
  mockFindUnique({ thumbnailKey: null, thumbState: "PENDING" });

  let updateArgs: unknown = null;
  mockUpdate((args: any) => {
    updateArgs = args;
    return { count: 1 };
  });

  const { storage, calls } = fakeStorage(Buffer.alloc(0));
  await processThumb(mockThumbDeps(storage), {
    type: "thumb",
    mediaId: "media-2b",
    userId: "user-2b",
    storageKey: "originals/media-2b.png",
    outKey: "thumbs/media-2b.webp",
    size: 256,
  });

  assert.ok(calls.includes("get"));
  assert.ok(!calls.includes("put"));

  const data = (updateArgs as { data: { thumbState: string; thumbError?: string } }).data;
  assert.equal(data.thumbState, "FAILED");
  assert.ok(typeof data.thumbError === "string");
  assert.ok((data.thumbError as string).length > 0);
});

test("processThumb throws when the source object is missing", async () => {
  mockFindUnique({ thumbnailKey: null, thumbState: "PENDING" });
  mockUpdate(() => ({} as any));

  const { storage } = fakeStorage(null);
  await assert.rejects(
    processThumb(mockThumbDeps(storage), {
      type: "thumb",
      mediaId: "media-3",
      userId: "user-3",
      storageKey: "originals/media-3.png",
      outKey: "thumbs/media-3.webp",
      size: 256,
    }),
    /SOURCE_NOT_READY/,
  );
});
