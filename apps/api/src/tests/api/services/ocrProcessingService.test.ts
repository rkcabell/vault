import test from "node:test";
import assert from "node:assert/strict";
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

type MediaRow = { id: string; textState: string; storageKey: string; sizeBytes: number; mimeType: string };

function makeDeps (opts: {
  findForOcr?: () => Promise<MediaRow | null>;
  setTextState?: (_id: string, state: string) => Promise<boolean>;
  upsertDocument?: (args: unknown) => Promise<void>;
  enqueueOcr?: () => Promise<void>;
  s3Send?: () => Promise<unknown>;
  textDeps?: OcrProcessingDeps["textDeps"];
  publishJobUpdate?: OcrProcessingDeps["publishJobUpdate"];
} = {}): OcrProcessingDeps {
  return {
    mediaRepository: {
      findForOcr: opts.findForOcr ?? (async () => null),
      setTextState: opts.setTextState ?? (async () => true),
    } as unknown as OcrProcessingDeps["mediaRepository"],
    documentRepository: {
      upsertDocument: opts.upsertDocument ?? (async () => {}),
    } as unknown as OcrProcessingDeps["documentRepository"],
    s3: { send: opts.s3Send ?? (async () => ({})) } as unknown as OcrProcessingDeps["s3"],
    bucket: "test-bucket",
    enqueueOcr: opts.enqueueOcr ?? (async () => {}),
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

// ── isTransientError ──────────────────────────────────────────────────────────

test("isTransientError: TextJobError with SOURCE_NOT_READY code → true", () => {
  assert.equal(isTransientError(new TextJobError("SOURCE_NOT_READY", "not ready")), true);
});

test("isTransientError: plain Error containing SOURCE_NOT_READY → true", () => {
  assert.equal(isTransientError(new Error("SOURCE_NOT_READY")), true);
});

test("isTransientError: NetworkingError → true", () => {
  assert.equal(isTransientError(new Error("NetworkingError: connection refused")), true);
});

test("isTransientError: Timeout → true", () => {
  assert.equal(isTransientError(new Error("Timeout after 30s")), true);
});

test("isTransientError: Throttling → true", () => {
  assert.equal(isTransientError(new Error("Throttling")), true);
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

test("processOcrJob: returns early without touching S3 when media is not found", async () => {
  let s3Called = false;
  const deps = makeDeps({
    findForOcr: async () => null,
    s3Send: async () => { s3Called = true; return {}; },
  });

  await processOcrJob(deps, { mediaId: "missing" });
  assert.equal(s3Called, false);
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

test("processOcrJob: returns early when textState is FAILED", async () => {
  let upsertCalled = false;
  const deps = makeDeps({
    findForOcr: async () => ({
      id: "m1", textState: "FAILED", storageKey: "k", sizeBytes: 0, mimeType: "image/png",
    }),
    upsertDocument: async () => { upsertCalled = true; },
  });

  await processOcrJob(deps, { mediaId: "m1" });
  assert.equal(upsertCalled, false);
});

test("processOcrJob: throws SOURCE_NOT_READY when S3 object is absent", async () => {
  const deps = makeDeps({
    findForOcr: async () => ({
      id: "m1", textState: "PENDING", storageKey: "missing/key", sizeBytes: 0, mimeType: "image/png",
    }),
    s3Send: async () => { throw new Error("Not Found"); },
  });

  await assert.rejects(
    () => processOcrJob(deps, { mediaId: "m1" }),
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

  await processOcrJob(deps, { mediaId: "m2" });

  const ua = upsertArgs as { rawText: string; textSource: string };
  assert.ok(ua.rawText.includes("OCR extracted result text content here"));
  assert.equal(ua.textSource, "OCR");
  assert.equal(textStateSet, "READY");
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

  await processOcrJob(deps, { mediaId: "m3", userId: "user-1" });

  assert.equal(updates.length, 1);
  const u = updates[0] as { field: string; value: string; userId: string };
  assert.equal(u.field, "textState");
  assert.equal(u.value, "READY");
  assert.equal(u.userId, "user-1");
});
