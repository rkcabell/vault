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
const originalFindFirst = prisma.media.findFirst.bind(prisma.media);
const originalUpdateMany = prisma.media.updateMany.bind(prisma.media);
const originalUpdate = prisma.media.update.bind(prisma.media);

function mockUpdate (fn: (args: any) => any) {
  (prisma.media as any).updateMany = async (args: any) => fn(args);
}

function mockFindUnique (result: any) {
  (prisma.media as any).findUnique = async () => result;
}

/** Backs `findReusableThumbnail` (the reuse lookup uses `findFirst`, not
 *  `findUnique`). Null = no twin. */
function mockFindFirst (result: any) {
  (prisma.media as any).findFirst = async () => result;
}

/** `setContentHash` runs unconditionally before the reuse check and isn't
 *  under test here — no-op it rather than hitting a real DB. */
function stubUpdate () {
  (prisma.media as any).update = async () => ({});
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

/** Fake storage keyed by object key, for reuse tests that need to tell "read
 *  the original source" apart from "read the twin's thumbnail." */
function fakeKeyedStorage (sources: Record<string, Buffer | null | undefined>): {
  storage: StorageAdapter; gets: string[]; puts: Array<{ key: string; body: Buffer }>;
} {
  const gets: string[] = [];
  const puts: Array<{ key: string; body: Buffer }> = [];
  const storage = {
    getObjectStream: async ({ key }: { key: string }) => {
      gets.push(key);
      const buf = sources[key];
      if (!buf) return null;
      return { body: Readable.from(buf), etag: null, contentLength: buf.length, totalLength: buf.length };
    },
    putObject: async ({ key, body }: { key: string; body: Buffer | Readable }) => {
      const bodyBuffer = Buffer.isBuffer(body)
        ? body
        : Buffer.concat(await streamToChunks(body));
      puts.push({ key, body: bodyBuffer });
    },
    deleteIfPresent: async () => {},
    objectExists: async () => true,
    presignPut: async () => "/api/storage/blob/x",
    presignGet: async () => "/api/storage/blob/x",
    usage: async () => ({ sizeBytes: 0, objectCount: 0 }),
  } as unknown as StorageAdapter;
  return { storage, gets, puts };
}

async function streamToChunks (stream: Readable): Promise<Buffer[]> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return chunks;
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
  (prisma.media as any).findFirst = originalFindFirst;
  (prisma.media as any).updateMany = originalUpdateMany;
  (prisma.media as any).update = originalUpdate;
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

test("processThumb marks UNSUPPORTED when no handler claims the input and Sharp cannot decode it", async () => {
  mockFindUnique({ thumbnailKey: null, thumbState: "PENDING", mimeType: "text/plain" });

  let updateArgs: unknown = null;
  mockUpdate((args: any) => {
    updateArgs = args;
    return { count: 1 };
  });

  const { storage, calls } = fakeStorage(Buffer.from("just some words"));
  await processThumb(mockThumbDeps(storage), {
    type: "thumb",
    mediaId: "media-2b",
    userId: "user-2b",
    storageKey: "originals/media-2b.txt",
    outKey: "thumbs/media-2b.webp",
    size: 256,
  });

  assert.ok(calls.includes("get"));
  assert.ok(!calls.includes("put"));

  const data = (updateArgs as { data: { thumbState: string; thumbError?: string } }).data;
  assert.equal(data.thumbState, "UNSUPPORTED");
});

test("processThumb still marks FAILED when a format handler claimed the input and its render failed", async () => {
  mockFindUnique({ thumbnailKey: null, thumbState: "PENDING", mimeType: "application/pdf" });

  let updateArgs: unknown = null;
  mockUpdate((args: any) => {
    updateArgs = args;
    return { count: 1 };
  });

  const { storage, calls } = fakeStorage(Buffer.from("%PDF-1.4 truncated"));
  await processThumb(mockThumbDeps(storage), {
    type: "thumb",
    mediaId: "media-2c",
    userId: "user-2c",
    storageKey: "originals/media-2c.pdf",
    outKey: "thumbs/media-2c.webp",
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

// ── thumbnail reuse (G2) ─────────────────────────────────────────────────────
// job.outKey/size are both omitted in these tests deliberately — that's what
// makes a job eligible for reuse (see the guard in thumbnailService.ts).

test("processThumb: reuse hit copies the twin's blob and never renders", async () => {
  mockFindUnique({ thumbnailKey: null, thumbState: "PENDING", mimeType: "application/pdf", sizeBytes: 20 });
  stubUpdate();
  mockFindFirst({ id: "twin-1", thumbnailKey: "thumbs/twin-1.webp" });

  let updateArgs: unknown = null;
  mockUpdate((args: any) => { updateArgs = args; return { count: 1 }; });

  const twinBytes = Buffer.from("not-really-a-webp-but-never-decoded");
  // Deliberately not a real PDF: reaching a renderer with these bytes would
  // throw, so the test only passes if the reuse branch short-circuited.
  const { storage, gets, puts } = fakeKeyedStorage({
    "originals/media-4.pdf": Buffer.from("garbage-original-bytes"),
    "thumbs/twin-1.webp": twinBytes,
  });

  await processThumb(mockThumbDeps(storage), {
    type: "thumb",
    mediaId: "media-4",
    userId: "user-4",
    storageKey: "originals/media-4.pdf",
  });

  assert.ok(gets.includes("originals/media-4.pdf"), "still reads the original to hash it");
  assert.ok(gets.includes("thumbs/twin-1.webp"), "reads the twin's blob to copy it");
  assert.equal(puts.length, 1);
  assert.equal(puts[0]!.key, "thumbs/media-4.webp");
  assert.ok(puts[0]!.body.equals(twinBytes), "copied verbatim, not re-encoded");
  assert.deepEqual((updateArgs as { data: unknown }).data, {
    thumbnailKey: "thumbs/media-4.webp",
    thumbState: "READY",
    thumbError: null,
  });
});

test("processThumb: reuse miss falls through to a normal render", async () => {
  const imageBuffer = await sharp({
    create: { width: 1, height: 1, channels: 3, background: { r: 0, g: 255, b: 0 } },
  }).png().toBuffer();

  mockFindUnique({ thumbnailKey: null, thumbState: "PENDING", mimeType: "image/png", sizeBytes: imageBuffer.length });
  stubUpdate();
  mockFindFirst(null); // no twin

  let updateArgs: unknown = null;
  mockUpdate((args: any) => { updateArgs = args; return { count: 1 }; });

  const { storage, gets, puts } = fakeKeyedStorage({ "originals/media-5.png": imageBuffer });

  await processThumb(mockThumbDeps(storage), {
    type: "thumb",
    mediaId: "media-5",
    userId: "user-5",
    storageKey: "originals/media-5.png",
  });

  assert.ok(gets.includes("originals/media-5.png"));
  assert.equal(puts.length, 1);
  assert.equal(puts[0]!.key, "thumbs/media-5.webp");
  assert.ok(!puts[0]!.body.equals(imageBuffer), "rendered (re-encoded to webp), not a raw copy");
  assert.equal((updateArgs as { data: { thumbState: string } }).data.thumbState, "READY");
});

test("processThumb: a gone twin blob falls through to a normal render", async () => {
  const imageBuffer = await sharp({
    create: { width: 1, height: 1, channels: 3, background: { r: 0, g: 0, b: 255 } },
  }).png().toBuffer();

  mockFindUnique({ thumbnailKey: null, thumbState: "PENDING", mimeType: "image/png", sizeBytes: imageBuffer.length });
  stubUpdate();
  // A twin row exists, but its blob is gone — findReusableThumbnail only
  // guarantees the row was READY with a key, not that the object still exists.
  mockFindFirst({ id: "twin-2", thumbnailKey: "thumbs/twin-2.webp" });

  let updateArgs: unknown = null;
  mockUpdate((args: any) => { updateArgs = args; return { count: 1 }; });

  const { storage, puts } = fakeKeyedStorage({
    "originals/media-6.png": imageBuffer,
    // "thumbs/twin-2.webp" intentionally absent — getObjectStream returns null.
  });

  await processThumb(mockThumbDeps(storage), {
    type: "thumb",
    mediaId: "media-6",
    userId: "user-6",
    storageKey: "originals/media-6.png",
  });

  assert.equal(puts.length, 1);
  assert.equal(puts[0]!.key, "thumbs/media-6.webp");
  assert.ok(!puts[0]!.body.equals(imageBuffer), "rendered fresh rather than failing the job");
  assert.equal((updateArgs as { data: { thumbState: string } }).data.thumbState, "READY");
});

test("processThumb: noReuse bypasses reuse even when a twin exists", async () => {
  const imageBuffer = await sharp({
    create: { width: 1, height: 1, channels: 3, background: { r: 255, g: 255, b: 0 } },
  }).png().toBuffer();

  mockFindUnique({ thumbnailKey: null, thumbState: "PENDING", mimeType: "image/png", sizeBytes: imageBuffer.length });
  stubUpdate();
  let findFirstCalled = false;
  (prisma.media as any).findFirst = async () => { findFirstCalled = true; return { id: "twin-3", thumbnailKey: "thumbs/twin-3.webp" }; };

  let updateArgs: unknown = null;
  mockUpdate((args: any) => { updateArgs = args; return { count: 1 }; });

  const { storage, gets } = fakeKeyedStorage({
    "originals/media-7.png": imageBuffer,
    "thumbs/twin-3.webp": Buffer.from("twin-bytes"),
  });

  await processThumb(mockThumbDeps(storage), {
    type: "thumb",
    mediaId: "media-7",
    userId: "user-7",
    storageKey: "originals/media-7.png",
    noReuse: true,
  });

  assert.equal(findFirstCalled, false, "regenerate must not even look for a twin");
  assert.ok(!gets.includes("thumbs/twin-3.webp"));
  assert.equal((updateArgs as { data: { thumbState: string } }).data.thumbState, "READY");
});

test("processThumb: a non-default size bypasses reuse", async () => {
  const imageBuffer = await sharp({
    create: { width: 1, height: 1, channels: 3, background: { r: 0, g: 0, b: 0 } },
  }).png().toBuffer();

  mockFindUnique({ thumbnailKey: null, thumbState: "PENDING", mimeType: "image/png", sizeBytes: imageBuffer.length });
  stubUpdate();
  let findFirstCalled = false;
  (prisma.media as any).findFirst = async () => { findFirstCalled = true; return { id: "twin-4", thumbnailKey: "thumbs/twin-4.webp" }; };

  let updateArgs: unknown = null;
  mockUpdate((args: any) => { updateArgs = args; return { count: 1 }; });

  const { storage } = fakeKeyedStorage({ "originals/media-8.png": imageBuffer });

  await processThumb(mockThumbDeps(storage), {
    type: "thumb",
    mediaId: "media-8",
    userId: "user-8",
    storageKey: "originals/media-8.png",
    size: 256, // a caller asking for a non-default size wants its own render
  });

  assert.equal(findFirstCalled, false, "a non-default size must not even look for a twin");
  assert.equal((updateArgs as { data: { thumbState: string } }).data.thumbState, "READY");
});
