import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import {
  createIngestService,
  IngestNotConfiguredError,
  IngestTooLargeError,
} from "@/services/media/ingestService.js";
import type { MediaRepository } from "@/repositories/mediaRepository.js";
import type { DiscoveredFile } from "@/worker/indexCore.js";

const ROOT = process.platform === "win32" ? "C:\\data" : "/data";
const INBOX = path.join(ROOT, "inbox");

type IndexCall = {
  userId: string;
  files: DiscoveredFile[];
  allowedRoots: string[];
  opts?: { ingestSource?: string };
};

function makeService (overrides: {
  folderPath?: string | null;
  allowedRoots?: string[];
  /** Absent = the folder exists; the real service stats it, so tests that need
   *  a live folder pass a temp dir instead. */
  savedAs?: string;
  sizeBytes?: number;
  foundId?: string | null;
  onWrite?: (folder: string, filename: string) => void;
  onUnlink?: () => void;
} = {}) {
  const indexCalls: IndexCall[] = [];
  const writes: { folder: string; filename: string }[] = [];

  const service = createIngestService({
    mediaRepository: {
      findIdBySourcePath: async () =>
        overrides.foundId === undefined ? "media-1" : overrides.foundId,
    } as unknown as MediaRepository,
    logger: { warn: () => {}, info: () => {} } as never,
    getIngestConfig: async () => ({
      folderPath: overrides.folderPath === undefined ? INBOX : overrides.folderPath,
      allowedRoots: overrides.allowedRoots ?? [ROOT],
    }),
    listTagRules: async () => [],
    writeFile: async (folder, filename) => {
      writes.push({ folder, filename });
      overrides.onWrite?.(folder, filename);
      const savedAs = overrides.savedAs ?? filename;
      return {
        path: path.join(folder, savedAs),
        savedAs,
        renamed: savedAs !== filename,
        sizeBytes: overrides.sizeBytes ?? 10,
        mtimeMs: 1_700_000_000_000,
      };
    },
    indexFilesFn: async (_deps, userId, files, allowedRoots, opts) => {
      indexCalls.push({ userId, files, allowedRoots, opts });
      return { indexed: files.length, skipped: 0 };
    },
  });

  return { service, indexCalls, writes };
}

const body = () => Readable.from([Buffer.from("bytes")]);

// ── resolveTarget ─────────────────────────────────────────────────────────────

test("resolveTarget: no allowed roots reports no-roots", async () => {
  const { service } = makeService({ allowedRoots: [] });
  const target = await service.resolveTarget("u");
  assert.equal(target.enabled, false);
  assert.equal(target.enabled === false && target.reason, "no-roots");
});

test("resolveTarget: no folder chosen reports not-set", async () => {
  const { service } = makeService({ folderPath: null });
  const target = await service.resolveTarget("u");
  assert.equal(target.enabled, false);
  assert.equal(target.enabled === false && target.reason, "not-set");
});

test("resolveTarget: a folder outside the roots reports outside-roots", async () => {
  const outside = process.platform === "win32" ? "C:\\elsewhere\\inbox" : "/elsewhere/inbox";
  const { service } = makeService({ folderPath: outside });
  const target = await service.resolveTarget("u");
  assert.equal(target.enabled, false);
  assert.equal(target.enabled === false && target.reason, "outside-roots");
});

test("resolveTarget: a folder that is not on disk reports missing", async () => {
  const { service } = makeService();
  const target = await service.resolveTarget("u");
  assert.equal(target.enabled, false);
  assert.equal(target.enabled === false && target.reason, "missing");
});

test("resolveTarget: a real folder inside a root is enabled", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "vault-inbox-"));
  const { service } = makeService({ folderPath: dir, allowedRoots: [tmpdir()] });
  const target = await service.resolveTarget("u");
  assert.equal(target.enabled, true);
  assert.equal(target.folderPath, dir);
});

// ── ingestFile ────────────────────────────────────────────────────────────────

/** A service whose destination folder really exists, so ingestFile gets past
 *  the stat and into the write + index path the assertions care about. */
async function makeLiveService (overrides: Parameters<typeof makeService>[0] = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "vault-inbox-"));
  return {
    dir,
    ...makeService({ folderPath: dir, allowedRoots: [tmpdir()], ...overrides }),
  };
}

test("ingestFile: refuses to write when no folder is configured", async () => {
  const { service } = makeService({ folderPath: null });
  await assert.rejects(
    () => service.ingestFile("u", { filename: "a.pdf", body: body() }),
    IngestNotConfiguredError,
  );
});

test("ingestFile: writes into the configured folder and indexes that path", async () => {
  const { service, indexCalls, writes, dir } = await makeLiveService();

  const result = await service.ingestFile("user-1", { filename: "invoice.pdf", body: body() });

  assert.equal(writes.length, 1);
  assert.equal(writes[0].folder, dir);
  assert.equal(indexCalls.length, 1);
  assert.equal(indexCalls[0].userId, "user-1");
  assert.equal(indexCalls[0].files.length, 1);
  assert.equal(indexCalls[0].files[0].name, "invoice.pdf");
  assert.equal(indexCalls[0].files[0].absPath, path.join(dir, "invoice.pdf"));
  assert.equal(result.id, "media-1");
});

// The file is an indexed file now, but it still arrived over HTTP — a rule
// keyed on source:upload has to go on matching it.
test("ingestFile: indexes with the upload source axis, not index", async () => {
  const { service, indexCalls } = await makeLiveService();
  await service.ingestFile("u", { filename: "a.pdf", body: body() });
  assert.equal(indexCalls[0].opts?.ingestSource, "upload");
});

test("ingestFile: carries the allow-list snapshot into indexing", async () => {
  const { service, indexCalls } = await makeLiveService();
  await service.ingestFile("u", { filename: "a.pdf", body: body() });
  assert.deepEqual(indexCalls[0].allowedRoots, [tmpdir()]);
});

test("ingestFile: reports the name a collision forced", async () => {
  const { service } = await makeLiveService({ savedAs: "invoice (2).pdf" });
  const result = await service.ingestFile("u", { filename: "invoice.pdf", body: body() });
  assert.equal(result.savedAs, "invoice (2).pdf");
  assert.equal(result.renamed, true);
});

test("ingestFile: indexes under the collision name, not the requested one", async () => {
  const { service, indexCalls, dir } = await makeLiveService({ savedAs: "invoice (2).pdf" });
  await service.ingestFile("u", { filename: "invoice.pdf", body: body() });
  assert.equal(indexCalls[0].files[0].name, "invoice (2).pdf");
  assert.equal(indexCalls[0].files[0].absPath, path.join(dir, "invoice (2).pdf"));
});

// Content-Length is a claim the client makes; the size that matters is the
// byte count written to disk, and an over-limit file must not stay there.
test("ingestFile: an oversize file is removed and never indexed", async () => {
  const { service, indexCalls } = await makeLiveService({ sizeBytes: 3 * 1024 * 1024 * 1024 });

  await assert.rejects(
    () => service.ingestFile("u", { filename: "huge.bin", body: body() }),
    IngestTooLargeError,
  );
  assert.equal(indexCalls.length, 0, "no row is created for a file that was removed");
});

// The live watcher sees the same file land and may index it first, in which
// case indexFiles skips it — the id still has to come back.
test("ingestFile: returns the id even when the watcher created the row", async () => {
  const { service } = await makeLiveService({ foundId: "watcher-made-this" });
  const result = await service.ingestFile("u", { filename: "a.pdf", body: body() });
  assert.equal(result.id, "watcher-made-this");
});

test("ingestFile: a file written but never rowed is an error, not a silent success", async () => {
  const { service } = await makeLiveService({ foundId: null });
  await assert.rejects(
    () => service.ingestFile("u", { filename: "a.pdf", body: body() }),
    /no media row exists/,
  );
});
