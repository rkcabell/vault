import test from "node:test";
import assert from "node:assert/strict";
import { Readable, PassThrough } from "node:stream";
import archiver from "archiver";
import { createUnpackProcessor } from "@/worker/unpackWorker.js";

// ── helpers ───────────────────────────────────────────────────────────────────

function makeLogger() {
  const logs: Array<{ obj: object; msg: string }> = [];
  return {
    logger: {
      info: (obj: object, msg: string) => { logs.push({ obj, msg }); },
      warn: (obj: unknown, msg: string) => { logs.push({ obj: obj as object, msg }); },
      error: (obj: object, msg: string) => { logs.push({ obj, msg }); },
    },
    logs,
  };
}

function makeJob(data: { mediaId: string; userId: string }) {
   
  return { data } as any;
}

async function makeZipBuffer(): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const pass = new PassThrough();
    pass.on("data", (chunk: Buffer) => chunks.push(chunk));
    pass.on("end", () => resolve(Buffer.concat(chunks)));
    pass.on("error", reject);
    const arc = archiver("zip");
    arc.on("error", reject);
    arc.pipe(pass);
    arc.append(Buffer.from("hello world"), { name: "photo.jpg" });
    arc.finalize();
  });
}

// ── tests ─────────────────────────────────────────────────────────────────────

test("createUnpackProcessor: returns early when media is not found", async () => {
  const { logger, logs } = makeLogger();
  const processor = createUnpackProcessor({
     
    mediaRepository: { findDetail: async () => null } as any,
     
    bundleRepository: {} as any,
     
    storage: {} as any,
    bucket: "test-bucket",
    logger,
  });

  await processor(makeJob({ mediaId: "m1", userId: "u1" }));

  const msgs = logs.map(l => l.msg);
  assert.ok(
    msgs.some(m => m.includes("no entries extracted")),
    `expected 'no entries extracted' log, got: ${JSON.stringify(msgs)}`,
  );
});

test("createUnpackProcessor: returns early when archive is already linked to a bundle", async () => {
  const { logger, logs } = makeLogger();
  const processor = createUnpackProcessor({
    mediaRepository: {
      findDetail: async () => ({
        id: "m1",
        storageKey: "orig/archive.zip",
        mimeType: "application/zip",
        title: "archive",
        filename: "archive.zip",
        linkedBundleId: "existing-bundle",
      }),
     
    } as any,
     
    bundleRepository: {} as any,
     
    storage: {} as any,
    bucket: "test-bucket",
    logger,
  });

  await processor(makeJob({ mediaId: "m1", userId: "u1" }));

  const msgs = logs.map(l => l.msg);
  assert.ok(
    msgs.some(m => m.includes("already linked")),
    `expected 'already linked' log, got: ${JSON.stringify(msgs)}`,
  );
});

test("createUnpackProcessor: logs bundleId after successful extraction", async () => {
  const zipBuffer = await makeZipBuffer();
  const { logger, logs } = makeLogger();

  const processor = createUnpackProcessor({
    mediaRepository: {
      findDetail: async () => ({
        id: "m1",
        storageKey: "orig/archive.zip",
        mimeType: "application/zip",
        title: "archive",
        filename: "archive.zip",
        linkedBundleId: null,
      }),
      createMedia: async () => {},
      setLinkedBundle: async () => {},
     
    } as any,
    bundleRepository: {
      createBundle: async () => ({ id: "bundle-1" }),
      addItems: async () => {},
      setSourceMedia: async () => {},
      updateBundle: async () => {},
     
    } as any,
    storage: {
      getObjectStream: async () => ({ body: Readable.from([zipBuffer]) }),
      // drain the entry stream so unzipper can advance past the single entry
       
      putObject: async ({ body }: any) => {
        if (body && typeof body.resume === "function") body.resume();
      },
     
    } as any,
    bucket: "test-bucket",
    logger,
  });

  await processor(makeJob({ mediaId: "m1", userId: "u1" }));

  const completedLog = logs.find(l => l.msg.includes("unpack job completed"));
  assert.ok(
    completedLog,
    `expected 'unpack job completed' log, got: ${JSON.stringify(logs.map(l => l.msg))}`,
  );
   
  assert.equal((completedLog.obj as any).bundleId, "bundle-1");
});
