import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import archiver from "archiver";
import { createArchiveService } from "@/services/media/archiveService.js";

// ── mock builders ─────────────────────────────────────────────────────────────

type Deps = Parameters<typeof createArchiveService>[0];
type BulkItem = { id: string; storageKey: string; title: string; mimeType: string | null; filename: string };

function makeRepo (overrides: {
  findBulkDownloadItems?: (_userId: string, _ids: string[]) => Promise<BulkItem[]>;
  findMimeTypesByIds?: (_userId: string, _ids: string[]) => Promise<{ id: string; mimeType: string }[]>;
  markThumbUnsupported?: (_ids: string[]) => Promise<void>;
  markTextUnsupported?: (_ids: string[]) => Promise<void>;
  findDetail?: (_userId: string, _id: string) => Promise<unknown>;
  createMedia?: (_data: unknown) => Promise<{ id: string; storageKey: string }>;
  setLinkedBundle?: (_mediaId: string, _bundleId: string) => Promise<void>;
} = {}) {
  return {
    findBulkDownloadItems: overrides.findBulkDownloadItems ?? (async () => []),
    findMimeTypesByIds: overrides.findMimeTypesByIds ?? (async () => []),
    markThumbUnsupported: overrides.markThumbUnsupported ?? (async () => {}),
    markTextUnsupported: overrides.markTextUnsupported ?? (async () => {}),
    findDetail: overrides.findDetail ?? (async () => null),
    createMedia: overrides.createMedia ?? (async (data: unknown) => {
      const d = data as { id: string; storageKey: string };
      return { id: d.id, storageKey: d.storageKey };
    }),
    setLinkedBundle: overrides.setLinkedBundle ?? (async () => {}),
  } as unknown as Deps["repository"];
}

function makeReadableStream (data = "file-bytes") {
  const s = new PassThrough();
  s.end(Buffer.from(data));
  return s;
}

function makeStorage (overrides: {
  getObjectStream?: (_args: unknown) => Promise<{ body: PassThrough; etag: null; contentLength: null } | null>;
  putObject?: (_args: unknown) => Promise<void>;
} = {}) {
  return {
    getObjectStream: overrides.getObjectStream ?? (async () => ({ body: makeReadableStream(), etag: null, contentLength: null })),
    putObject: overrides.putObject ?? (async () => {}),
  } as unknown as Deps["storage"];
}

function makeBundleRepo () {
  return {
    createBundle: async () => ({ id: "bundle-1" }),
    addItems: async () => true,
    updateBundle: async () => {},
    setSourceMedia: async () => {},
    deleteBundle: async () => {},
  } as unknown as Deps["bundleRepository"];
}

const serviceLogger = { warn: () => {} };

function makeService (repoOverrides = {}, storageOverrides = {}, extra: Partial<Deps> = {}) {
  return createArchiveService({
    repository: makeRepo(repoOverrides),
    bundleRepository: makeBundleRepo(),
    storage: makeStorage(storageOverrides),
    bucket: "test-bucket",
    logger: serviceLogger,
    ...extra,
  });
}

// ── getBulkDownloadItems ──────────────────────────────────────────────────────

test("getBulkDownloadItems: returns empty array when no owned items found", async () => {
  const svc = makeService();
  const result = await svc.getBulkDownloadItems("u", ["id-1", "id-2"]);
  assert.deepEqual(result, []);
});

test("getBulkDownloadItems: forwards userId and ids to repository", async () => {
  let calledWith: { userId: string; ids: string[] } | null = null;
  const svc = makeService({
    findBulkDownloadItems: async (userId: string, ids: string[]) => {
      calledWith = { userId, ids };
      return [];
    },
  });

  await svc.getBulkDownloadItems("user-42", ["a", "b", "c"]);
  assert.deepEqual(calledWith, { userId: "user-42", ids: ["a", "b", "c"] });
});

test("getBulkDownloadItems: returns items from repository", async () => {
  const items: BulkItem[] = [
    { id: "m1", storageKey: "k1", title: "Photo", mimeType: "image/jpeg", filename: "photo.jpg" },
    { id: "m2", storageKey: "k2", title: "Doc", mimeType: "application/pdf", filename: "doc.pdf" },
  ];
  const svc = makeService({ findBulkDownloadItems: async () => items });
  const result = await svc.getBulkDownloadItems("u", ["m1", "m2"]);
  assert.deepEqual(result, items);
});

// ── streamBulkArchive ─────────────────────────────────────────────────────────

function collectStream (dest: PassThrough): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    dest.on("data", (chunk: Buffer) => chunks.push(chunk));
    dest.on("end", () => resolve(Buffer.concat(chunks)));
    dest.on("error", reject);
  });
}

/** streamBulkArchive takes a per-request logger, separate from the service dep. */
const streamLogger = { error: () => {} };

test("streamBulkArchive: produces non-empty zip output", async () => {
  const items: BulkItem[] = [
    { id: "m1", storageKey: "k1", title: "Photo", mimeType: "image/jpeg", filename: "photo.jpg" },
  ];
  const svc = makeService({}, { getObjectStream: async () => ({ body: makeReadableStream("image-data"), etag: null, contentLength: null }) });

  const dest = new PassThrough();
  const collected = collectStream(dest);
  await svc.streamBulkArchive(items, dest, streamLogger, []);
  const buf = await collected;

  // Zip files begin with the PK magic bytes (0x50 0x4B)
  assert.ok(buf.length > 0, "output is non-empty");
  assert.equal(buf[0], 0x50, "starts with P (zip magic)");
  assert.equal(buf[1], 0x4b, "starts with K (zip magic)");
});

test("streamBulkArchive: calls getObjectStream for each item", async () => {
  const keys: string[] = [];
  const items: BulkItem[] = [
    { id: "m1", storageKey: "key/a", title: "A", mimeType: "image/png", filename: "a.png" },
    { id: "m2", storageKey: "key/b", title: "B", mimeType: "image/png", filename: "b.png" },
  ];
  const svc = makeService({}, {
    getObjectStream: async (args: unknown) => {
      keys.push((args as { key: string }).key);
      return { body: makeReadableStream(), etag: null, contentLength: null };
    },
  });

  const dest = new PassThrough();
  await svc.streamBulkArchive(items, dest, streamLogger, []);

  assert.deepEqual(keys, ["key/a", "key/b"]);
});

test("streamBulkArchive: skips items where storage returns null", async () => {
  const items: BulkItem[] = [
    { id: "missing", storageKey: "gone", title: "Gone", mimeType: null, filename: "gone.txt" },
    { id: "present", storageKey: "here", title: "Here", mimeType: "text/plain", filename: "here.txt" },
  ];
  let streamCalls = 0;
  const svc = makeService({}, {
    getObjectStream: async (args: unknown) => {
      streamCalls++;
      const key = (args as { key: string }).key;
      if (key === "gone") return null;
      return { body: makeReadableStream("content"), etag: null, contentLength: null };
    },
  });

  const dest = new PassThrough();
  const collected = collectStream(dest);
  await svc.streamBulkArchive(items, dest, streamLogger, []);
  const buf = await collected;

  assert.equal(streamCalls, 2, "attempted both items");
  assert.ok(buf.length > 0, "still produced a zip (from the present item)");
});

test("streamBulkArchive: deduplicates filenames when two items share a title", async () => {
  // We verify deduplication indirectly: the archive must finalize without error,
  // meaning archiver accepted two distinct entry names (no collision crash).
  const items: BulkItem[] = [
    { id: "m1", storageKey: "k1", title: "Report", mimeType: "application/pdf", filename: "report.pdf" },
    { id: "m2", storageKey: "k2", title: "Report", mimeType: "application/pdf", filename: "report2.pdf" },
  ];
  const svc = makeService({}, {
    getObjectStream: async () => ({ body: makeReadableStream("data"), etag: null, contentLength: null }),
  });

  const dest = new PassThrough();
  const collected = collectStream(dest);
  await svc.streamBulkArchive(items, dest, streamLogger, []);
  const buf = await collected;

  // Zip contains both entries — a zip with 2 files is always larger than one with 1
  assert.ok(buf.length > 0);
  // The central directory contains filenames; check both expected names appear in the raw bytes
  const content = buf.toString("binary");
  assert.ok(content.includes("Report.pdf"), "first entry has plain name");
  assert.ok(content.includes("Report_2.pdf"), "second entry has deduplicated name");
});

test("streamBulkArchive: falls back to original filename extension for unknown mimeType", async () => {
  const items: BulkItem[] = [
    { id: "m1", storageKey: "k1", title: "Mystery", mimeType: "application/octet-stream", filename: "mystery.dat" },
  ];
  const svc = makeService({}, {
    getObjectStream: async () => ({ body: makeReadableStream(), etag: null, contentLength: null }),
  });

  const dest = new PassThrough();
  const collected = collectStream(dest);
  await svc.streamBulkArchive(items, dest, streamLogger, []);
  const buf = await collected;

  assert.ok(buf.toString("binary").includes("Mystery.dat"), "uses extension from original filename");
});

test("streamBulkArchive: falls back to original filename extension when mimeType is null", async () => {
  const items: BulkItem[] = [
    { id: "m1", storageKey: "k1", title: "NoType", mimeType: null, filename: "notype.heic" },
  ];
  const svc = makeService({}, {
    getObjectStream: async () => ({ body: makeReadableStream(), etag: null, contentLength: null }),
  });

  const dest = new PassThrough();
  const collected = collectStream(dest);
  await svc.streamBulkArchive(items, dest, streamLogger, []);
  const buf = await collected;

  assert.ok(buf.toString("binary").includes("NoType.heic"), "uses extension from original filename");
});

test("streamBulkArchive: produces no extension when mimeType and filename both lack one", async () => {
  const items: BulkItem[] = [
    { id: "m1", storageKey: "k1", title: "Bare", mimeType: null, filename: "bare" },
  ];
  const svc = makeService({}, {
    getObjectStream: async () => ({ body: makeReadableStream(), etag: null, contentLength: null }),
  });

  const dest = new PassThrough();
  const collected = collectStream(dest);
  await svc.streamBulkArchive(items, dest, streamLogger, []);
  const buf = await collected;

  // Entry is stored as just "Bare" with no extension
  assert.ok(buf.toString("binary").includes("Bare"), "entry exists");
  assert.ok(!buf.toString("binary").includes("Bare."), "no spurious extension appended");
});

test("streamBulkArchive: falls back to item id when title sanitizes to empty string", async () => {
  const items: BulkItem[] = [
    { id: "abc-123", storageKey: "k1", title: "///", mimeType: "image/png", filename: "img.png" },
  ];
  const svc = makeService({}, {
    getObjectStream: async () => ({ body: makeReadableStream(), etag: null, contentLength: null }),
  });

  const dest = new PassThrough();
  const collected = collectStream(dest);
  await svc.streamBulkArchive(items, dest, streamLogger, []);
  const buf = await collected;

  assert.ok(buf.toString("binary").includes("abc-123.png"), "falls back to item id");
});

// ── unpackArchive ─────────────────────────────────────────────────────────────
//
// Unpack must not fan out to any derivative queue: an archive of ten thousand
// entries is the unbounded push the pull model removed. This service
// holds no thumb/text/ocr queue at all, so that is now a property of the deps
// type rather than something a test has to catch.

/** Build a real ZIP buffer so the actual extractArchive/unzipper path runs. */
function buildZip (entries: [string, string][]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const archive = archiver("zip");
    const chunks: Buffer[] = [];
    archive.on("data", (c: Buffer) => chunks.push(c));
    archive.on("end", () => resolve(Buffer.concat(chunks)));
    archive.on("error", reject);
    for (const [name, content] of entries) archive.append(content, { name });
    void archive.finalize();
  });
}

/** Drain each extracted entry stream so unzipper advances to the next. */
const drainingPutObject = async ({ body }: { body: Readable }) => {
  await new Promise<void>((res, rej) => {
    body.on("end", res);
    body.on("error", rej);
    body.resume();
  });
};

test("unpackArchive: leaves entries at PENDING for the feeder, marks the incompatible ones", async () => {
  const zip = await buildZip([
    ["photo.png", "png-bytes"],   // thumb + ocr
    ["clip.mp4", "mp4-bytes"],    // thumb only
    ["notes.txt", "text-bytes"],  // neither
  ]);

  let thumbUnsupported: string[] | null = null;
  let textUnsupported: string[] | null = null;
  // Map storageKey → assigned media id so we can resolve which file each id is.
  const idToName = new Map<string, string>();
  const nameToHashState = new Map<string, string>();

  const svc = makeService(
    {
      findDetail: async () => ({
        id: "arc-1", storageKey: "k/archive.zip", mimeType: "application/zip",
        title: "archive", filename: "archive.zip",
      }),
      createMedia: async (data: unknown) => {
        const d = data as { id: string; storageKey: string; filename: string; hashState: string };
        idToName.set(d.id, d.filename);
        nameToHashState.set(d.filename, d.hashState);
        return { id: d.id, storageKey: d.storageKey };
      },
      markThumbUnsupported: async (ids: string[]) => { thumbUnsupported = ids; },
      markTextUnsupported: async (ids: string[]) => { textUnsupported = ids; },
    },
    {
      // Hand the unpacker a real zip stream.
      getObjectStream: async () => ({ body: Readable.from(zip), etag: null, contentLength: null }) as never,
      putObject: drainingPutObject as never,
    },
  );

  const result = await svc.unpackArchive("u", "arc-1");
  assert.deepEqual(result, { bundleId: "bundle-1" });

  const thumbUnsupportedNames = (thumbUnsupported as string[] | null ?? []).map(id => idToName.get(id));
  const textUnsupportedNames = ((textUnsupported as string[] | null ?? []).map(id => idToName.get(id))).sort();
  // Marking the incompatible entries is the part that still matters: a row left
  // at PENDING for a type that can never render would be claimed by the feeder
  // once a tick forever, feeding a job that can only fail.
  assert.deepEqual(thumbUnsupportedNames, ["notes.txt"], "txt marked thumb-unsupported");
  assert.deepEqual(textUnsupportedNames, ["clip.mp4"], "only video marked text-unsupported");

  // hashState, written from the same planDerivations rule indexFiles uses —
  // this was the real gap: unpacked non-renderable entries used to stay
  // contentHash: null forever, since nothing here ever enqueued a hash job.
  assert.equal(nameToHashState.get("photo.png"), "UNSUPPORTED", "renderable — thumb worker hashes it inline");
  assert.equal(nameToHashState.get("clip.mp4"), "UNSUPPORTED", "renderable — thumb worker hashes it inline");
  assert.equal(nameToHashState.get("notes.txt"), "PENDING", "not renderable — needs its own hash job");
});

test("unpackArchive: autoTagOnIngest off leaves entries with only the bundle name", async () => {
  const tagsByName = new Map<string, string[]>();

  const makeSvc = (getAutoTagOnIngest?: (userId: string) => Promise<boolean>) =>
    makeService(
      {
        findDetail: async () => ({
          id: "arc-1", storageKey: "k/archive.zip", mimeType: "application/zip",
          title: "archive", filename: "archive.zip",
        }),
        createMedia: async (data: unknown) => {
          const d = data as { id: string; storageKey: string; filename: string; tags: string[] };
          tagsByName.set(d.filename, d.tags);
          return { id: d.id, storageKey: d.storageKey };
        },
      },
      {
        getObjectStream: async () => ({ body: Readable.from(zip), etag: null, contentLength: null }) as never,
        putObject: drainingPutObject as never,
      },
      { getAutoTagOnIngest },
    );

  let zip = await buildZip([["notes.txt", "text-bytes"]]);
  await makeSvc().unpackArchive("u", "arc-1");
  assert.deepEqual(tagsByName.get("notes.txt"), ["archive", "source:unpacked"], "absent dep means enabled");

  zip = await buildZip([["notes.txt", "text-bytes"]]);
  await makeSvc(async () => false).unpackArchive("u", "arc-1");
  // The bundle name survives: it records which archive this came out of, which
  // is structural, not a rule result.
  assert.deepEqual(tagsByName.get("notes.txt"), ["archive"]);
});

// An in-place archive used to return null here — the old code only ever read
// managed storage, so an indexed or sent .zip could not be unpacked at all.
test("unpackArchive: an in-place archive is read from disk, not from storage", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "vault-unpack-"));
  const archivePath = path.join(dir, "archive.zip");
  await writeFile(archivePath, await buildZip([["notes.txt", "text-bytes"]]));

  const created: string[] = [];
  const svc = makeService(
    {
      findDetail: async () => ({
        id: "arc-1", storageKey: null, sourcePath: archivePath,
        mimeType: "application/zip", title: "archive", filename: "archive.zip",
      }),
      createMedia: async (data: unknown) => {
        const d = data as { id: string; storageKey: string; filename: string };
        created.push(d.filename);
        return { id: d.id, storageKey: d.storageKey };
      },
    },
    {
      getObjectStream: async () => { throw new Error("must not read managed storage"); },
      // Entries still land in managed storage — extracting into the user's
      // folder would write into a tree Vault only ever reads.
      putObject: drainingPutObject as never,
    },
  );

  const result = await svc.unpackArchive("u", "arc-1", [dir]);

  assert.deepEqual(result, { bundleId: "bundle-1" });
  assert.deepEqual(created, ["notes.txt"]);
});

test("unpackArchive: an in-place archive outside the allow-list is refused", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "vault-unpack-"));
  const archivePath = path.join(dir, "archive.zip");
  await writeFile(archivePath, await buildZip([["notes.txt", "text-bytes"]]));

  const svc = createArchiveService({
    repository: makeRepo({
      findDetail: async () => ({
        id: "arc-1", storageKey: null, sourcePath: archivePath,
        mimeType: "application/zip", title: "archive", filename: "archive.zip",
      }),
    }),
    bundleRepository: {
      createBundle: async () => { throw new Error("must not create a bundle"); },
    } as unknown as Deps["bundleRepository"],
    storage: {} as unknown as Deps["storage"],
    bucket: "test-bucket",
    logger: serviceLogger,
  });

  await assert.rejects(() => svc.unpackArchive("u", "arc-1", []), /allowed indexing roots/);
});

// ── enqueueUnpackForArchives ──────────────────────────────────────────────────
//
// Backs POST /media/unpack-new — what is left of the old finalize step once
// ingest started creating rows itself.

test("enqueueUnpackForArchives: queues only the archives in the batch", async () => {
  const enqueued: { mediaId: string; allowedRoots: string[] }[] = [];
  const svc = makeService({}, {}, {
    unpackQueue: {
      add: async (_name: string, data: { mediaId: string; allowedRoots: string[] }) => {
        enqueued.push({ mediaId: data.mediaId, allowedRoots: data.allowedRoots });
      },
    } as unknown as Deps["unpackQueue"],
    repository: makeRepo({
      findMimeTypesByIds: async () => [
        { id: "zip-1", mimeType: "application/zip" },
        { id: "pdf-1", mimeType: "application/pdf" },
      ],
    }),
  });

  const result = await svc.enqueueUnpackForArchives("u", ["zip-1", "pdf-1"], ["C:\\nas"]);

  assert.deepEqual(result, { queued: 1 });
  assert.equal(enqueued.length, 1, "the pdf is not an archive");
  assert.equal(enqueued[0].mediaId, "zip-1");
  // The allow-list snapshot travels with the job — the worker re-validates the
  // source path against it, and its own env list is empty.
  assert.deepEqual(enqueued[0].allowedRoots, ["C:\\nas"]);
});

test("enqueueUnpackForArchives: a failed enqueue is logged, not thrown", async () => {
  const warnings: unknown[] = [];
  const svc = makeService({}, {}, {
    logger: { warn: (obj: unknown) => warnings.push(obj) },
    unpackQueue: {
      add: async () => { throw new Error("redis down"); },
    } as unknown as Deps["unpackQueue"],
    repository: makeRepo({
      findMimeTypesByIds: async () => [{ id: "zip-1", mimeType: "application/zip" }],
    }),
  });

  // The rows already exist; the user can still unpack by hand.
  const result = await svc.enqueueUnpackForArchives("u", ["zip-1"], []);

  assert.deepEqual(result, { queued: 0 });
  assert.equal(warnings.length, 1);
});

test("enqueueUnpackForArchives: an unwired queue throws rather than reporting a silent zero", async () => {
  const svc = makeService({}, {}, {
    repository: makeRepo({
      findMimeTypesByIds: async () => [{ id: "zip-1", mimeType: "application/zip" }],
    }),
  });

  await assert.rejects(
    () => svc.enqueueUnpackForArchives("u", ["zip-1"], []),
    /needs an unpackQueue/,
  );
});
