import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import sensible from "@fastify/sensible";
import { ingestRoutes } from "@/routes/ingest.js";
import {
  createIngestService,
  IngestNotConfiguredError,
  IngestTooLargeError,
  type IngestResult,
  type IngestTarget,
} from "@/services/media/ingestService.js";
import { UnsafeIngestFilenameError } from "@/lib/media/ingestWrite.js";

type Opts = {
  resolveTarget?: () => Promise<IngestTarget>;
  ingestFile?: (u: string, input: { filename: string }) => Promise<IngestResult>;
};

const OK: IngestResult = {
  id: "media-1",
  savedAs: "invoice.pdf",
  renamed: false,
  sourcePath: "/data/inbox/invoice.pdf",
  sizeBytes: 12,
};

async function buildApp (opts: Opts = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(sensible);

  (app as any).decorate("jwt", {
    verifyAccess: () => ({ sub: "user-1" }),
    signAccess: () => "",
    signRefresh: () => "",
    verifyRefresh: () => ({ sub: "user-1" }),
  });
  // PUT /file/* attaches a limiter at registration time; no-op here.
  (app as any).decorate("userRateLimit", () => async () => {});
  (app as any).decorate("mediaServices", {
    ingestService: {
      resolveTarget: opts.resolveTarget
        ?? (async () => ({ enabled: true, folderPath: "/data/inbox", allowedRoots: ["/data"] })),
      ingestFile: opts.ingestFile ?? (async () => OK),
    },
  });

  await app.register(ingestRoutes);
  appsToClose.push(app);
  return app;
}

const appsToClose: FastifyInstance[] = [];
test.after(async () => {
  await Promise.all(appsToClose.map(app => app.close()));
});

const AUTH = { authorization: "Bearer test-token" };

// ── GET /config ───────────────────────────────────────────────────────────────

test("GET /config: reports the destination folder when sending is set up", async () => {
  const app = await buildApp();
  const res = await app.inject({ method: "GET", url: "/config", headers: AUTH });

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().enabled, true);
  assert.equal(res.json().folderPath, "/data/inbox");
  assert.ok(res.json().maxBytes > 0);
});

// The page renders its setup state from this, so an unconfigured install has to
// get an answer rather than an error — the same rule item 1's /api/sidecars
// status route follows.
test("GET /config: answers with the reason when sending is not set up", async () => {
  const app = await buildApp({
    resolveTarget: async () => ({ enabled: false, folderPath: null, reason: "not-set" }),
  });
  const res = await app.inject({ method: "GET", url: "/config", headers: AUTH });

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().enabled, false);
  assert.equal(res.json().reason, "not-set");
  assert.ok(res.json().message.length > 0, "carries something the user can act on");
});

test("GET /config: unauthenticated returns 401", async () => {
  const app = await buildApp();
  const res = await app.inject({ method: "GET", url: "/config" });
  assert.equal(res.statusCode, 401);
});

// ── PUT /file/* ───────────────────────────────────────────────────────────────

test("PUT /file: returns 201 with the media id and the name on disk", async () => {
  const app = await buildApp();
  const res = await app.inject({
    method: "PUT", url: "/file/invoice.pdf",
    headers: { ...AUTH, "content-type": "application/pdf" },
    payload: "bytes",
  });

  assert.equal(res.statusCode, 201);
  assert.equal(res.json().id, "media-1");
  assert.equal(res.json().savedAs, "invoice.pdf");
});

test("PUT /file: a percent-encoded name arrives decoded", async () => {
  let seen: string | undefined;
  const app = await buildApp({
    ingestFile: async (_u, input) => { seen = input.filename; return OK; },
  });

  await app.inject({
    method: "PUT", url: `/file/${encodeURIComponent("my report (final).pdf")}`,
    headers: { ...AUTH, "content-type": "application/pdf" },
    payload: "bytes",
  });

  assert.equal(seen, "my report (final).pdf");
});

test("PUT /file: only the basename of a traversing path reaches the service", async () => {
  let seen: string | undefined;
  const app = await buildApp({
    ingestFile: async (_u, input) => { seen = input.filename; return OK; },
  });

  await app.inject({
    method: "PUT", url: `/file/${encodeURIComponent("../../etc/passwd")}`,
    headers: { ...AUTH, "content-type": "text/plain" },
    payload: "bytes",
  });

  assert.equal(seen, "passwd");
});

test("PUT /file: an unconfigured destination returns 409, not a 500", async () => {
  const app = await buildApp({
    ingestFile: async () => { throw new IngestNotConfiguredError("not-set"); },
  });

  const res = await app.inject({
    method: "PUT", url: "/file/a.pdf",
    headers: { ...AUTH, "content-type": "application/pdf" },
    payload: "bytes",
  });

  assert.equal(res.statusCode, 409);
  assert.match(res.json().message, /folder/i);
});

test("PUT /file: an oversize file returns 400 with the limit message", async () => {
  const app = await buildApp({
    ingestFile: async () => { throw new IngestTooLargeError("huge.bin exceeds the files limit (2 GB max)."); },
  });

  const res = await app.inject({
    method: "PUT", url: "/file/huge.bin",
    headers: { ...AUTH, "content-type": "application/octet-stream" },
    payload: "bytes",
  });

  assert.equal(res.statusCode, 400);
  assert.match(res.json().message, /2 GB/);
});

test("PUT /file: an unusable filename returns 400", async () => {
  const app = await buildApp({
    ingestFile: async () => { throw new UnsafeIngestFilenameError("..."); },
  });

  const res = await app.inject({
    method: "PUT", url: "/file/x",
    headers: { ...AUTH, "content-type": "application/octet-stream" },
    payload: "bytes",
  });

  assert.equal(res.statusCode, 400);
});

test("PUT /file: unauthenticated returns 401", async () => {
  const app = await buildApp();
  const res = await app.inject({
    method: "PUT", url: "/file/a.pdf",
    headers: { "content-type": "application/pdf" },
    payload: "bytes",
  });
  assert.equal(res.statusCode, 401);
});

// ── Wired end to end ──────────────────────────────────────────────────────────
//
// The route, the real ingestService, the real writeIngestFile and the real
// indexFiles, against a real folder — only the repository is faked. The unit
// tests above each substitute one of those, so this is the only check that they
// are connected: a request in, a file on disk, a row described.

async function buildRealApp (): Promise<{ app: FastifyInstance; dir: string; rows: any[] }> {
  const dir = await mkdtemp(path.join(tmpdir(), "vault-e2e-"));
  const rows: any[] = [];

  const repository = {
    findExistingSourcePaths: async () => new Set<string>(),
    backfillFileDates: async () => {},
    createBatch: async (batch: any[]) => { rows.push(...batch); },
    markTextUnsupported: async () => {},
    markThumbUnsupported: async () => {},
    markThumbTooLarge: async () => {},
    findIdBySourcePath: async (_u: string, p: string) =>
      rows.find(r => r.sourcePath === p)?.id ?? null,
  };

  const app = Fastify({ logger: false });
  await app.register(sensible);
  (app as any).decorate("jwt", {
    verifyAccess: () => ({ sub: "user-1" }),
    signAccess: () => "", signRefresh: () => "", verifyRefresh: () => ({ sub: "user-1" }),
  });
  (app as any).decorate("userRateLimit", () => async () => {});
  (app as any).decorate("mediaServices", {
    ingestService: createIngestService({
      mediaRepository: repository as never,
      logger: { warn: () => {}, info: () => {} } as never,
      getIngestConfig: async () => ({ folderPath: dir, allowedRoots: [dir] }),
      listTagRules: async () => [],
    }),
  });
  await app.register(ingestRoutes);
  appsToClose.push(app);
  return { app, dir, rows };
}

test("wired: a sent file lands on disk and gets an indexed row pointing at it", async () => {
  const { app, dir, rows } = await buildRealApp();

  const res = await app.inject({
    method: "PUT", url: "/file/report.pdf",
    headers: { ...AUTH, "content-type": "application/pdf" },
    payload: Buffer.from("%PDF-1.4 pretend"),
  });

  assert.equal(res.statusCode, 201);
  assert.equal(res.json().savedAs, "report.pdf");

  // The bytes are a real file in the folder, under their own name.
  assert.deepEqual(await readdir(dir), ["report.pdf"]);
  assert.equal(await readFile(path.join(dir, "report.pdf"), "utf8"), "%PDF-1.4 pretend");

  // And the row is an in-place row, not a managed one.
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sourcePath, path.join(dir, "report.pdf"));
  assert.equal(rows[0].storageKey, null);
  assert.equal(rows[0].sourceState, "READY");
  assert.equal(rows[0].thumbState, "PENDING", "left for the feeder to claim");
  assert.equal(rows[0].mimeType, "application/pdf");
  assert.equal(res.json().id, rows[0].id);
});

test("wired: a second file of the same name is renamed, and the first is untouched", async () => {
  const { app, dir } = await buildRealApp();
  const send = (payload: string) => app.inject({
    method: "PUT", url: "/file/report.pdf",
    headers: { ...AUTH, "content-type": "application/pdf" },
    payload,
  });

  await send("first");
  const second = await send("second");

  assert.equal(second.json().savedAs, "report (2).pdf");
  assert.equal(second.json().renamed, true);
  assert.equal(await readFile(path.join(dir, "report.pdf"), "utf8"), "first");
  assert.equal(await readFile(path.join(dir, "report (2).pdf"), "utf8"), "second");
});

test("wired: the source:upload tag survives the move to in-place rows", async () => {
  const { app, rows } = await buildRealApp();

  await app.inject({
    method: "PUT", url: "/file/photo.png",
    headers: { ...AUTH, "content-type": "image/png" },
    payload: "png",
  });

  assert.ok(
    rows[0].tags.includes("source:upload"),
    `expected source:upload among ${JSON.stringify(rows[0].tags)}`,
  );
});
