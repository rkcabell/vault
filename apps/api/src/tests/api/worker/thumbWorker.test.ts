//File: apps/api/src/tests/unit/thumbWorker.test.ts

import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import sharp from "sharp";
import { s3 } from "@/plugins/s3Client.js";
import { prisma } from "@vault/db";
import { processThumb, ThumbDeps } from "@/worker/thumbWorker.js";

process.env.NODE_ENV = "test";
process.env.S3_BUCKET = "test-bucket";
process.env.REDIS_URL = "redis://localhost:6379";
process.env.THUMB_QUEUE = "thumb:queue";

const originalSend = s3.send.bind(s3);
const originalFindUnique = prisma.media.findUnique.bind(prisma.media);
const originalUpdate = prisma.media.update.bind(prisma.media);

function mockUpdate (fn: (args: any) => any) {
  (prisma.media as any).update = async (args: any) => fn(args);
}

function mockFindUnique (result: any) {
  (prisma.media as any).findUnique = async () => result;
}

function mockS3Send (fn: (cmd: any) => any) {
  (s3 as any).send = async (cmd: any) => fn(cmd);
}

function mockThumbDeps (): ThumbDeps {
  return {
    prisma,
    s3,
    bucket: "test-bucket",
  };
}

afterEach(() => {
  (s3 as any).send = originalSend;
  (prisma.media as any).findUnique = originalFindUnique;
  (prisma.media as any).update = originalUpdate;
});

test("processThumb marks READY when thumbnail already exists", async () => {
  const outKey = "thumbs/media-1.webp";

  mockFindUnique({ thumbnailKey: outKey, thumbState: "PENDING" });

  let updateArgs: unknown = null;
  mockUpdate((args: any) => {
    updateArgs = args;
    return {} as any;
  });

  mockS3Send(() => {
    throw new Error("unexpected s3 call");
  });

  await processThumb(mockThumbDeps(), {
    type: "thumb",
    mediaId: "media-1",
    userId: "user-1",
    storageKey: "originals/media-1.png",
    outKey,
    size: 128,
  });

  assert.deepEqual((updateArgs as { data: unknown }).data, {
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

  const seenCommands: string[] = [];
  mockS3Send((cmd: any) => {
    seenCommands.push(cmd.constructor.name);
    if (cmd instanceof HeadObjectCommand) return {};
    if (cmd instanceof GetObjectCommand) return { Body: Readable.from(imageBuffer) };
    if (cmd instanceof PutObjectCommand) return {};
    throw new Error("unexpected s3 command");
  });

  mockFindUnique({ thumbnailKey: null, thumbState: "PENDING" });

  let updateArgs: unknown = null;
  mockUpdate((args: any) => {
    updateArgs = args;
    return {} as any;
  });

  await processThumb(mockThumbDeps(),{
    type: "thumb",
    mediaId: "media-2",
    userId: "user-2",
    storageKey: "originals/media-2.png",
    outKey: "thumbs/media-2.webp",
    size: 256,
  });

  assert.ok(seenCommands.includes("HeadObjectCommand"));
  assert.ok(seenCommands.includes("GetObjectCommand"));
  assert.ok(seenCommands.includes("PutObjectCommand"));
  assert.deepEqual((updateArgs as { data: unknown }).data, {
    thumbnailKey: "thumbs/media-2.webp",
    thumbState: "READY",
    thumbError: null,
  });
});

test("processThumb marks FAILED when input cannot be decoded", async () => {
  const invalidBuffer = Buffer.alloc(0);

  const seenCommands: string[] = [];
  mockS3Send((cmd: any) => {
    seenCommands.push(cmd.constructor.name);
    if (cmd instanceof HeadObjectCommand) return {};
    if (cmd instanceof GetObjectCommand) return { Body: Readable.from(invalidBuffer) };
    if (cmd instanceof PutObjectCommand) return {};
    throw new Error("unexpected s3 command");
  });

  mockFindUnique({ thumbnailKey: null, thumbState: "PENDING" });

  let updateArgs: unknown = null;
  mockUpdate((args: any) => {
    updateArgs = args;
    return {} as any;
  });

  await processThumb(mockThumbDeps(), {
    type: "thumb",
    mediaId: "media-2b",
    userId: "user-2b",
    storageKey: "originals/media-2b.png",
    outKey: "thumbs/media-2b.webp",
    size: 256,
  });

  assert.ok(seenCommands.includes("HeadObjectCommand"));
  assert.ok(seenCommands.includes("GetObjectCommand"));
  assert.ok(!seenCommands.includes("PutObjectCommand"));

  const data = (updateArgs as { data: { thumbState: string; thumbError?: string } }).data;
  assert.equal(data.thumbState, "FAILED");
  assert.ok(typeof data.thumbError === "string");
  assert.ok((data.thumbError as string).length > 0);
});

test("processThumb throws when the source object is missing", async () => {
  mockS3Send((cmd: any) => {
    if (cmd instanceof HeadObjectCommand) return {};
    if (cmd instanceof GetObjectCommand) return { Body: null };
    return {};
  });

  mockFindUnique({ thumbnailKey: null, thumbState: "PENDING" });
  mockUpdate(() => ({} as any));

  await assert.rejects(
    processThumb(mockThumbDeps(), {
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
