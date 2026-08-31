import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  computeOcrTimeout,
  isTransientError,
  processOcrJob,
  type OcrProcessingDeps,
} from "@/services/ocrProcessingService.js";
import { TextJobError } from "@/lib/text/processTextJob.js";
import type { Logger } from "pino";

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

// ── PDF fixture ───────────────────────────────────────────────────────────────

function buildMinimalPdf (text: string): Buffer {
  const stream = `BT /F1 24 Tf 72 120 Td (${text}) Tj ET`;
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n",
    `4 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`,
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  ];

  let offset = 0;
  const chunks: string[] = [];
  const offsets: number[] = [0];
  const header = "%PDF-1.4\n";
  chunks.push(header);
  offset += header.length;
  for (const obj of objects) {
    offsets.push(offset);
    chunks.push(obj);
    offset += obj.length;
  }
  const xrefOffset = offset;
  const xrefLines = ["xref\n", "0 6\n", "0000000000 65535 f \n"];
  for (let i = 1; i <= 5; i += 1) {
    xrefLines.push(`${String(offsets[i]).padStart(10, "0")} 00000 n \n`);
  }
  chunks.push(xrefLines.join(""));
  chunks.push(`trailer\n<< /Root 1 0 R /Size 6 >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
  return Buffer.from(chunks.join(""), "ascii");
}

// ── mock builder ──────────────────────────────────────────────────────────────

type MediaRow = {
  id: string; textState: string; storageKey: string; sizeBytes: number; mimeType: string;
  userId?: string; contentHash?: string | null;
};
type ReusableDocument = { id: string; rawText: string; pages: unknown; textSource: string | null };

function makeDeps (opts: {
  findForOcr?: () => Promise<MediaRow | null>;
  setTextState?: (_id: string, state: string) => Promise<boolean>;
  addTagIfAbsent?: (_id: string, _tag: string) => Promise<void>;
  upsertDocument?: (args: unknown) => Promise<void>;
  enqueueOcr?: () => Promise<void>;
  onStorageRead?: () => void;
  textDeps?: OcrProcessingDeps["textDeps"];
  publishJobUpdate?: OcrProcessingDeps["publishJobUpdate"];
  /** Left unset on purpose: the service then falls back to DEFAULT_PREFERENCES
   *  ("onDemand"), so tests exercise the shipping default unless they opt out.
   *  Tests that want tier-2 OCR to run must ask for "background". */
  getOcrMode?: OcrProcessingDeps["getOcrMode"];
  getOcrTimeoutCapMinutes?: OcrProcessingDeps["getOcrTimeoutCapMinutes"];
  /** No twin by default — every existing test's row also carries no
   *  contentHash, so the reuse check never fires unless a test opts in. */
  findReusableDocument?: (_userId: string, _hash: string, _excludeId: string) => Promise<ReusableDocument | null>;
} = {}): OcrProcessingDeps {
  return {
    mediaRepository: {
      findForOcr: opts.findForOcr ?? (async () => null),
      setTextState: opts.setTextState ?? (async () => true),
      addTagIfAbsent: opts.addTagIfAbsent ?? (async () => {}),
      findReusableDocument: opts.findReusableDocument ?? (async () => null),
    } as unknown as OcrProcessingDeps["mediaRepository"],
    documentRepository: {
      upsertDocument: opts.upsertDocument ?? (async () => {}),
    } as unknown as OcrProcessingDeps["documentRepository"],
    storage: {
      getObjectStream: async () => { opts.onStorageRead?.(); return null; },
      putObject: async () => {},
      deleteIfPresent: async () => {},
      objectExists: async () => true,
      presignPut: async () => "/api/storage/blob/x",
      presignGet: async () => "/api/storage/blob/x",
      usage: async () => ({ sizeBytes: 0, objectCount: 0 }),
    } as unknown as OcrProcessingDeps["storage"],
    bucket: "test-bucket",
    enqueueOcr: opts.enqueueOcr ?? (async () => {}),
    getOcrMode: opts.getOcrMode,
    getOcrTimeoutCapMinutes: opts.getOcrTimeoutCapMinutes,
    logger,
    queueName: "ocr",
    sleep: async () => {},
    timeoutMs: 2_000,
    textDeps: opts.textDeps,
    publishJobUpdate: opts.publishJobUpdate,
  };
}

// ── computeOcrTimeout ─────────────────────────────────────────────────────────

test("computeOcrTimeout: zero bytes → 60 s base", () => {
  assert.equal(computeOcrTimeout(0), 60_000);
});

test("computeOcrTimeout: 1 MB → 90 s (base + 30 s/MB)", () => {
  assert.equal(computeOcrTimeout(1024 * 1024), 90_000);
});

test("computeOcrTimeout: 5 MB → 210 s", () => {
  assert.equal(computeOcrTimeout(5 * 1024 * 1024), 210_000);
});

test("computeOcrTimeout: large file caps at 10 minutes", () => {
  assert.equal(computeOcrTimeout(100 * 1024 * 1024), 600_000);
  assert.equal(computeOcrTimeout(999 * 1024 * 1024), 600_000);
});

test("computeOcrTimeout: result never exceeds 600 000 ms", () => {
  assert.ok(computeOcrTimeout(Number.MAX_SAFE_INTEGER) <= 600_000);
});

test("computeOcrTimeout: custom cap overrides the 10-minute default", () => {
  assert.equal(computeOcrTimeout(100 * 1024 * 1024, 5 * 60_000), 300_000);
  assert.equal(computeOcrTimeout(0, 5 * 60_000), 60_000);
});

test("processOcrJob: getOcrTimeoutCapMinutes resolves the cap when deps.timeoutMs is unset", async () => {
  let loggedTimeoutMs: number | null = null;
  const spyLogger = {
    info: (obj: Record<string, unknown>) => { if ("timeoutMs" in obj) loggedTimeoutMs = obj.timeoutMs as number; },
    warn: () => {},
    error: () => {},
    debug: () => {},
  } as unknown as Logger;

  const ocrPdf = buildMinimalPdf("cap test output");
  const deps = {
    ...makeDeps({
      findForOcr: async () => ({
        id: "cap1", textState: "PENDING", storageKey: "s/big.pdf", sizeBytes: 100 * 1024 * 1024,
        mimeType: "application/pdf",
      }),
      textDeps: {
        getObjectBuffer: async () => Buffer.from("x"),
        ocrWithOcrmypdf: async () => ({ ocrPdf }),
      },
      getOcrTimeoutCapMinutes: async () => 5,
    }),
    logger: spyLogger,
    timeoutMs: undefined,
  };

  await processOcrJob(deps, { mediaId: "cap1", forceOcr: true });

  assert.equal(loggedTimeoutMs, 5 * 60_000, "a 100 MB file should be capped at the custom 5-minute limit, not the 10-minute default");
});

// ── isTransientError ──────────────────────────────────────────────────────────

test("isTransientError: TextJobError with SOURCE_NOT_READY code → true", () => {
  assert.equal(isTransientError(new TextJobError("SOURCE_NOT_READY", "not ready")), true);
});

test("isTransientError: plain Error containing SOURCE_NOT_READY → true", () => {
  assert.equal(isTransientError(new Error("SOURCE_NOT_READY")), true);
});

test("isTransientError: Timeout → true", () => {
  assert.equal(isTransientError(new Error("Timeout after 30s")), true);
});

test("isTransientError: non-transient Error → false", () => {
  assert.equal(isTransientError(new Error("INVALID_INPUT")), false);
  assert.equal(isTransientError(new Error("permission denied")), false);
});

test("isTransientError: string value is checked as message", () => {
  assert.equal(isTransientError("SOURCE_NOT_READY"), true);
  assert.equal(isTransientError("something random"), false);
});

test("isTransientError: non-error values → false", () => {
  assert.equal(isTransientError(null), false);
  assert.equal(isTransientError(42), false);
  assert.equal(isTransientError({}), false);
});

// ── processOcrJob ─────────────────────────────────────────────────────────────

test("processOcrJob: returns early without touching storage when media is not found", async () => {
  let storageCalled = false;
  const deps = makeDeps({
    findForOcr: async () => null,
    onStorageRead: () => { storageCalled = true; },
  });

  await processOcrJob(deps, { mediaId: "missing" });
  assert.equal(storageCalled, false);
});

test("processOcrJob: returns early when textState is ERROR", async () => {
  let upsertCalled = false;
  const deps = makeDeps({
    findForOcr: async () => ({
      id: "m1", textState: "ERROR", storageKey: "k", sizeBytes: 0, mimeType: "image/png",
    }),
    upsertDocument: async () => { upsertCalled = true; },
  });

  await processOcrJob(deps, { mediaId: "m1" });
  assert.equal(upsertCalled, false);
});

test("processOcrJob: returns early when textState is UNSUPPORTED", async () => {
  let upsertCalled = false;
  const deps = makeDeps({
    findForOcr: async () => ({
      id: "m1", textState: "UNSUPPORTED", storageKey: "k", sizeBytes: 0, mimeType: "image/png",
    }),
    upsertDocument: async () => { upsertCalled = true; },
  });

  await processOcrJob(deps, { mediaId: "m1" });
  assert.equal(upsertCalled, false);
});

test("processOcrJob: throws SOURCE_NOT_READY when the source object is absent", async () => {
  const deps = makeDeps({
    findForOcr: async () => ({
      id: "m1", textState: "PENDING", storageKey: "missing/key", sizeBytes: 0, mimeType: "image/png",
    }),
    textDeps: { getObjectBuffer: async () => null } as unknown as OcrProcessingDeps["textDeps"],
  });

  // Reaching the source read at all requires tier 2, and since the queue split
  // no ocrMode runs tier 2 from a tier-1 job — `background` enqueues instead.
  // forceOcr is what a job pulled off ocr_queue carries.
  await assert.rejects(
    () => processOcrJob(deps, { mediaId: "m1", forceOcr: true }),
    (err: unknown) => err instanceof TextJobError && (err as TextJobError).code === "SOURCE_NOT_READY",
  );
});

test("processOcrJob: PDF path extracts native text and sets textState READY", async () => {
  const pdfBuffer = buildMinimalPdf("This page has enough native text to pass the threshold easily.");
  let upsertArgs: unknown = null;
  let textStateSet: string | null = null;

  const deps = makeDeps({
    findForOcr: async () => ({
      id: "m1", textState: "PENDING", storageKey: "s/k.pdf", sizeBytes: 1024,
      mimeType: "application/pdf",
    }),
    upsertDocument: async (args) => { upsertArgs = args; },
    setTextState: async (_id, state) => { textStateSet = state; return true; },
    textDeps: { getObjectBuffer: async () => pdfBuffer },
  });

  await processOcrJob(deps, { mediaId: "m1" });

  assert.ok(upsertArgs !== null, "upsertDocument was called");
  const ua = upsertArgs as { rawText: string; mediaId: string };
  assert.ok(ua.rawText.length > 0, "extracted text is non-empty");
  assert.equal(ua.mediaId, "m1");
  assert.equal(textStateSet, "READY");
});

test("processOcrJob: non-PDF path runs OCR and sets textState READY", async () => {
  const ocrPdf = buildMinimalPdf("OCR extracted result text content here");
  let upsertArgs: unknown = null;
  let textStateSet: string | null = null;

  const deps = makeDeps({
    findForOcr: async () => ({
      id: "m2", textState: "PENDING", storageKey: "s/scan.png", sizeBytes: 2048,
      mimeType: "image/png",
    }),
    upsertDocument: async (args) => { upsertArgs = args; },
    setTextState: async (_id, state) => { textStateSet = state; return true; },
    textDeps: {
      getObjectBuffer: async () => Buffer.from("fake-image-bytes"),
      ocrWithOcrmypdf: async () => ({ ocrPdf }),
    },
  });

  // An image is pure tier-2 work: this is the ocr_queue job, not the text_queue
  // one that parked the row.
  await processOcrJob(deps, { mediaId: "m2", forceOcr: true });

  const ua = upsertArgs as { rawText: string; textSource: string };
  assert.ok(ua.rawText.includes("OCR extracted result text content here"));
  assert.equal(ua.textSource, "OCR");
  assert.equal(textStateSet, "READY");
});

test("processOcrJob: plain-text path reads directly (NATIVE), no OCR", async () => {
  let upsertArgs: unknown = null;
  let textStateSet: string | null = null;
  let ocrmypdfCalled = false;
  const tags: string[] = [];

  const deps = makeDeps({
    findForOcr: async () => ({
      id: "txt1", textState: "PENDING", storageKey: "s/notes.md", sizeBytes: 42,
      mimeType: "text/markdown",
    }),
    upsertDocument: async (args) => { upsertArgs = args; },
    setTextState: async (_id, state) => { textStateSet = state; return true; },
    addTagIfAbsent: async (_id, tag) => { tags.push(tag); },
    textDeps: {
      getObjectBuffer: async () => Buffer.from("# Title\nsearchable body text", "utf8"),
      ocrWithOcrmypdf: async () => { ocrmypdfCalled = true; return { ocrPdf: Buffer.alloc(0) }; },
    },
  });

  await processOcrJob(deps, { mediaId: "txt1" });

  const ua = upsertArgs as { rawText: string; textSource: string; pages: unknown };
  assert.equal(ocrmypdfCalled, false, "ocrmypdf must not run for plain text");
  assert.equal(ua.rawText, "# Title\nsearchable body text");
  assert.equal(ua.textSource, "NATIVE");
  assert.deepEqual(ua.pages, []);
  assert.equal(textStateSet, "READY");
  assert.ok(tags.includes("has-text"), "non-empty text gets the has-text tag");
});

test("processOcrJob: oversized text file is skipped (UNSUPPORTED), no extraction", async () => {
  let upsertCalled = false;
  let textStateSet: string | null = null;
  let bufferRead = false;

  const deps = makeDeps({
    findForOcr: async () => ({
      id: "bigtxt", textState: "PENDING", storageKey: "s/huge.log", sizeBytes: 10 * 1024 * 1024,
      mimeType: "text/plain",
    }),
    upsertDocument: async () => { upsertCalled = true; },
    setTextState: async (_id, state) => { textStateSet = state; return true; },
    textDeps: { getObjectBuffer: async () => { bufferRead = true; return Buffer.from("x"); } },
  });

  await processOcrJob(deps, { mediaId: "bigtxt" });

  assert.equal(textStateSet, "UNSUPPORTED");
  assert.equal(upsertCalled, false, "no document upserted for oversized text");
  assert.equal(bufferRead, false, "oversized file is never read into memory");
});

test("processOcrJob: fires publishJobUpdate with READY on success", async () => {
  const ocrPdf = buildMinimalPdf("some text for ocr");
  const updates: unknown[] = [];

  const deps = makeDeps({
    findForOcr: async () => ({
      id: "m3", textState: "PENDING", storageKey: "s/k.png", sizeBytes: 0, mimeType: "image/png",
    }),
    setTextState: async () => true,
    textDeps: {
      getObjectBuffer: async () => Buffer.from("x"),
      ocrWithOcrmypdf: async () => ({ ocrPdf }),
    },
    publishJobUpdate: (u) => { updates.push(u); },
  });

  await processOcrJob(deps, { mediaId: "m3", userId: "user-1", forceOcr: true });

  const textStateUpdate = updates.find((u) => (u as { field?: string }).field === "textState") as
    | { field: string; value: string; userId: string }
    | undefined;
  assert.ok(textStateUpdate, "textState update should be published");
  assert.equal(textStateUpdate.field, "textState");
  assert.equal(textStateUpdate.value, "READY");
  assert.equal(textStateUpdate.userId, "user-1");
});

// ── ocrMode: deferring tier-2 (Tesseract) work ────────────────────────────────

test("processOcrJob: onDemand parks an image at NEEDS_OCR without reading it", async () => {
  let textStateSet: string | null = null;
  let ocrmypdfCalled = false;
  let sourceRead = false;

  const deps = makeDeps({
    findForOcr: async () => ({
      id: "img1", textState: "PENDING", storageKey: "s/scan.png", sizeBytes: 2048,
      mimeType: "image/png",
    }),
    setTextState: async (_id, state) => { textStateSet = state; return true; },
    textDeps: {
      getObjectBuffer: async () => { sourceRead = true; return Buffer.from("x"); },
      ocrWithOcrmypdf: async () => { ocrmypdfCalled = true; return { ocrPdf: Buffer.alloc(0) }; },
    },
    // getOcrMode unset → DEFAULT_PREFERENCES.ocrMode ("onDemand")
  });

  await processOcrJob(deps, { mediaId: "img1" });

  assert.equal(textStateSet, "NEEDS_OCR");
  assert.equal(ocrmypdfCalled, false, "Tesseract must not run under onDemand");
  assert.equal(sourceRead, false, "deferring must not even read the source");
});

test("processOcrJob: forceOcr overrides onDemand — the user asked for it", async () => {
  const ocrPdf = buildMinimalPdf("forced ocr text output");
  let textStateSet: string | null = null;
  let ocrmypdfCalled = false;

  const deps = makeDeps({
    findForOcr: async () => ({
      id: "img2", textState: "NEEDS_OCR", storageKey: "s/scan.png", sizeBytes: 2048,
      mimeType: "image/png",
    }),
    setTextState: async (_id, state) => { textStateSet = state; return true; },
    textDeps: {
      getObjectBuffer: async () => Buffer.from("x"),
      ocrWithOcrmypdf: async () => { ocrmypdfCalled = true; return { ocrPdf }; },
    },
  });

  await processOcrJob(deps, { mediaId: "img2", forceOcr: true });

  assert.equal(ocrmypdfCalled, true, "forceOcr runs Tesseract regardless of mode");
  assert.equal(textStateSet, "READY");
});

test("processOcrJob: a scanned PDF parks at NEEDS_OCR and queues nothing under onDemand", async () => {
  // No text layer → pdf.js reports needsOcr, which is the deferral trigger.
  const scanPdf = buildMinimalPdf("");
  let textStateSet: string | null = null;
  let enqueued = 0;

  const deps = makeDeps({
    findForOcr: async () => ({
      id: "pdf1", textState: "PENDING", storageKey: "s/scan.pdf", sizeBytes: 4096,
      mimeType: "application/pdf",
    }),
    setTextState: async (_id, state) => { textStateSet = state; return true; },
    enqueueOcr: async () => { enqueued += 1; },
    textDeps: { getObjectBuffer: async () => scanPdf },
  });

  await processOcrJob(deps, { mediaId: "pdf1" });

  assert.equal(textStateSet, "NEEDS_OCR");
  assert.equal(enqueued, 0, "onDemand must not queue the fallback");
});

test("processOcrJob: background mode queues the scanned-PDF fallback behind user work", async () => {
  const scanPdf = buildMinimalPdf("");
  const enqueuedOpts: unknown[] = [];

  const deps = makeDeps({
    findForOcr: async () => ({
      id: "pdf2", textState: "PENDING", storageKey: "s/scan.pdf", sizeBytes: 4096,
      mimeType: "application/pdf",
    }),
    textDeps: { getObjectBuffer: async () => scanPdf },
    getOcrMode: async () => "background",
  });
  // makeDeps types enqueueOcr as a no-arg thunk; capture the real args here.
  deps.enqueueOcr = async (_data, opts) => { enqueuedOpts.push(opts); };

  await processOcrJob(deps, { mediaId: "pdf2" });

  assert.equal(enqueuedOpts.length, 1, "background mode queues the fallback");
  const opts = enqueuedOpts[0] as { priority?: number };
  assert.ok(
    typeof opts.priority === "number" && opts.priority > 1,
    "sweeper work must yield to user-initiated extraction (priority 1)",
  );
});

// ── the queue split: tier 1 must never run Tesseract itself ───────────────────

test("processOcrJob: background mode hands an image to tier 2 instead of running it", async () => {
  let ocrmypdfCalled = false;
  let sourceRead = false;
  let textStateSet: string | null = null;
  const enqueued: { data: unknown; opts: unknown }[] = [];

  const deps = makeDeps({
    findForOcr: async () => ({
      id: "img3", textState: "PENDING", storageKey: "s/photo.png", sizeBytes: 2048,
      mimeType: "image/png",
    }),
    setTextState: async (_id, state) => { textStateSet = state; return true; },
    textDeps: {
      getObjectBuffer: async () => { sourceRead = true; return Buffer.from("x"); },
      ocrWithOcrmypdf: async () => { ocrmypdfCalled = true; return { ocrPdf: Buffer.alloc(0) }; },
    },
    getOcrMode: async () => "background",
  });
  deps.enqueueOcr = async (data, opts) => { enqueued.push({ data, opts }); };

  await processOcrJob(deps, { mediaId: "img3" });

  // This is the whole point of splitting the queues: a job on text_queue that
  // meets Tesseract work enqueues it rather than holding a high-concurrency slot
  // for the length of the run. Before the split, background mode shelled out here.
  assert.equal(ocrmypdfCalled, false, "tier 1 must never shell out to ocrmypdf");
  assert.equal(sourceRead, false, "handing off must not read the source either");
  assert.equal(textStateSet, "NEEDS_OCR");
  assert.equal(enqueued.length, 1, "background mode hands the image to ocr_queue");
  assert.equal((enqueued[0].data as { forceOcr?: boolean }).forceOcr, true);
});

test("processOcrJob: a PDF whose native pass fails is handed off, not OCR'd in place", async () => {
  let ocrmypdfCalled = false;
  let textStateSet: string | null = null;
  let enqueued = 0;

  const deps = makeDeps({
    findForOcr: async () => ({
      id: "pdf3", textState: "PENDING", storageKey: "s/broken.pdf", sizeBytes: 4096,
      mimeType: "application/pdf",
    }),
    setTextState: async (_id, state) => { textStateSet = state; return true; },
    textDeps: {
      // Not a PDF at all → pdf.js throws something other than SOURCE_NOT_READY,
      // which is the "fall through to OCR" path.
      getObjectBuffer: async () => Buffer.from("not a pdf"),
      ocrWithOcrmypdf: async () => { ocrmypdfCalled = true; return { ocrPdf: Buffer.alloc(0) }; },
    },
    getOcrMode: async () => "background",
  });
  deps.enqueueOcr = async () => { enqueued += 1; };

  await processOcrJob(deps, { mediaId: "pdf3" });

  assert.equal(ocrmypdfCalled, false, "the pdf.js-failure fallback is tier-2 work too");
  assert.equal(textStateSet, "NEEDS_OCR");
  assert.equal(enqueued, 1);
});

test("processOcrJob: the tier-2 handoff carries the in-place allow-list snapshot", async () => {
  const enqueued: unknown[] = [];
  const root = path.join(path.sep, "nas");
  const source = path.join(root, "scan.png");

  // An image, so the deferral happens before any source read — the point here is
  // the shape of the handoff, not the extraction.
  const deps = makeDeps({
    findForOcr: async () => ({
      id: "img4", textState: "PENDING", storageKey: "external/u/img4/scan.png",
      sizeBytes: 2048, mimeType: "image/png", sourcePath: source,
    }),
    getOcrMode: async () => "background",
  });
  deps.enqueueOcr = async (data) => { enqueued.push(data); };

  await processOcrJob(deps, { mediaId: "img4", allowedRoots: [root] });

  // Without this the tier-2 job re-validates the source path against an empty
  // allow-list and the read is rejected — the handoff would always fail.
  const data = enqueued[0] as { sourcePath?: string; allowedRoots?: string[] };
  assert.equal(data.sourcePath, source);
  assert.deepEqual(data.allowedRoots, [root]);
});

// ── text/OCR reuse (G2) ──────────────────────────────────────────────────────

test("processOcrJob: reuses an identical file's already-extracted text, skips both tiers", async () => {
  let upsertArgs: unknown = null;
  let textStateSet: string | null = null;
  let storageRead = false;
  let findReusableArgs: unknown = null;

  const deps = makeDeps({
    findForOcr: async () => ({
      id: "m1", userId: "u1", textState: "PENDING", storageKey: "s/k.pdf", sizeBytes: 1024,
      mimeType: "application/pdf", contentHash: "abc123",
    }),
    upsertDocument: async (args) => { upsertArgs = args; },
    setTextState: async (_id, state) => { textStateSet = state; return true; },
    onStorageRead: () => { storageRead = true; },
    findReusableDocument: async (userId, hash, excludeId) => {
      findReusableArgs = { userId, hash, excludeId };
      return { id: "twin", rawText: "reused text", pages: null, textSource: "NATIVE" };
    },
  });

  await processOcrJob(deps, { mediaId: "m1", userId: "u1" });

  assert.deepEqual(findReusableArgs, { userId: "u1", hash: "abc123", excludeId: "m1" });
  assert.equal(storageRead, false, "never reads the source when reusing");
  const ua = upsertArgs as { rawText: string; mediaId: string; textSource: string };
  assert.equal(ua.mediaId, "m1");
  assert.equal(ua.rawText, "reused text");
  assert.equal(ua.textSource, "NATIVE");
  assert.equal(textStateSet, "READY");
});

test("processOcrJob: forceOcr:true still reuses — skips an entire Tesseract run", async () => {
  let upsertArgs: unknown = null;
  let storageRead = false;

  const deps = makeDeps({
    findForOcr: async () => ({
      id: "m1", userId: "u1", textState: "NEEDS_OCR", storageKey: "s/scan.png", sizeBytes: 2048,
      mimeType: "image/png", contentHash: "hash-x",
    }),
    upsertDocument: async (args) => { upsertArgs = args; },
    onStorageRead: () => { storageRead = true; },
    findReusableDocument: async () => ({ id: "twin", rawText: "already ocr'd", pages: null, textSource: "OCR" }),
    // No textDeps.ocrWithOcrmypdf: if reuse didn't short-circuit before the
    // real tier-2 path, this would throw trying to run Tesseract with no fixture.
  });

  await processOcrJob(deps, { mediaId: "m1", userId: "u1", forceOcr: true });

  assert.equal(storageRead, false, "the whole point — skips reading the source at all");
  const ua = upsertArgs as { rawText: string; textSource: string };
  assert.equal(ua.rawText, "already ocr'd");
  assert.equal(ua.textSource, "OCR");
});

test("processOcrJob: no contentHash means no reuse attempt", async () => {
  let reuseCalled = false;

  const deps = makeDeps({
    findForOcr: async () => ({
      id: "m1", userId: "u1", textState: "PENDING", storageKey: "missing/key", sizeBytes: 0,
      mimeType: "image/png", contentHash: null,
    }),
    textDeps: { getObjectBuffer: async () => null } as unknown as OcrProcessingDeps["textDeps"],
    findReusableDocument: async () => { reuseCalled = true; return null; },
  });

  // Falls through to the normal path, which fails the same way the existing
  // "source object is absent" test does — proof the reuse check was skipped
  // rather than silently swallowed.
  await assert.rejects(
    () => processOcrJob(deps, { mediaId: "m1", userId: "u1", forceOcr: true }),
    (err: unknown) => err instanceof TextJobError && (err as TextJobError).code === "SOURCE_NOT_READY",
  );
  assert.equal(reuseCalled, false, "must not even query for a twin without a hash");
});
