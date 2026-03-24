import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LOG_FORMATTERS, buildTransportTargets } from "@/lib/logger.js";
import { initLogFile, getActiveLogFile, CURRENT_PTR } from "@/lib/logFileManager.js";

// ─── LOG_FORMATTERS ───────────────────────────────────────────────────────────

const fmt = LOG_FORMATTERS!.log!.bind(LOG_FORMATTERS);

test("LOG_FORMATTERS strips all STRIP_FIELDS entries", () => {
  const input = {
    msg: "hello",
    userId: "abc-123",
    jobId: "job-456",
    key: "s3/some/path",
    mimeType: "image/jpeg",
    queue: "thumb",
    attempt: 1,
    timeoutMs: 5000,
    forceOcr: false,
    ocrPdfBytes: 99999,
  };
  const out = fmt(input);
  assert.equal(out.msg, "hello");
  for (const field of ["userId", "jobId", "key", "mimeType", "queue", "attempt", "timeoutMs", "forceOcr", "ocrPdfBytes"]) {
    assert.equal(out[field], undefined, `${field} should be stripped`);
  }
});

test("LOG_FORMATTERS truncates mediaId at first hyphen", () => {
  const out = fmt({ mediaId: "aabbccdd-1111-2222-3333-ffffffffffff" });
  assert.equal(out.mediaId, "aabbccdd");
});

test("LOG_FORMATTERS leaves mediaId unchanged when no hyphen", () => {
  const out = fmt({ mediaId: "nohyphen" });
  assert.equal(out.mediaId, "nohyphen");
});

test("LOG_FORMATTERS passes through non-stripped fields unchanged", () => {
  const out = fmt({ filename: "test.pdf", sizeBytes: 1024, bundleId: "bundle-1" });
  assert.equal(out.filename, "test.pdf");
  assert.equal(out.sizeBytes, 1024);
  assert.equal(out.bundleId, "bundle-1");
});

test("LOG_FORMATTERS handles empty object", () => {
  const out = fmt({});
  assert.deepEqual(out, {});
});

// ─── buildTransportTargets ────────────────────────────────────────────────────

test("buildTransportTargets returns exactly two targets", () => {
  assert.equal(buildTransportTargets("info").length, 2);
});

test("buildTransportTargets first target is pino-pretty with colorize", () => {
  const [pretty] = buildTransportTargets("debug");
  assert.equal(pretty.target, "pino-pretty");
  assert.equal(pretty.level, "debug");
  assert.equal((pretty.options as { colorize: boolean }).colorize, true);
});

test("buildTransportTargets second target points to fileTransport.mjs", () => {
  const [, file] = buildTransportTargets("warn");
  assert.match(file.target, /fileTransport\.mjs$/);
  assert.equal(file.level, "warn");
  const fileOpts = file.options as { currentPtr: string };
  assert.equal(typeof fileOpts.currentPtr, "string");
  assert.ok(fileOpts.currentPtr.length > 0);
});

test("buildTransportTargets defaults level to info", () => {
  const targets = buildTransportTargets();
  assert.equal(targets[0].level, "info");
  assert.equal(targets[1].level, "info");
});

// ─── logFileManager ───────────────────────────────────────────────────────────
// These tests write real files into the project's logs/ directory (same location
// the API server uses). Each test cleans up what it creates.

function cleanupTestLogs(created: string[]) {
  for (const f of created) {
    try { fs.unlinkSync(f); } catch { /* already gone */ }
  }
}

test("initLogFile creates a timestamped .log file", () => {
  const logFile = initLogFile();
  try {
    assert.ok(fs.existsSync(logFile), "log file should exist on disk");
    assert.match(
      path.basename(logFile),
      /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.log$/,
      "filename should be ISO-timestamp formatted",
    );
  } finally {
    cleanupTestLogs([logFile]);
  }
});

test("initLogFile writes the column-header box at the top of the file", () => {
  const logFile = initLogFile();
  try {
    const content = fs.readFileSync(logFile, "utf8");
    assert.ok(content.includes("DATE"), "header must include DATE column label");
    assert.ok(content.includes("MESSAGE"), "header must include MESSAGE column label");
    assert.ok(content.includes("LEVEL"), "header must include LEVEL column label");
    assert.ok(content.includes("╔"), "header must include top box-drawing char");
    assert.ok(content.includes("╚"), "header must include bottom box-drawing char");
  } finally {
    cleanupTestLogs([logFile]);
  }
});

test("initLogFile updates .current pointer to the new file", () => {
  const logFile = initLogFile();
  try {
    assert.ok(fs.existsSync(CURRENT_PTR), ".current should exist");
    const ptr = fs.readFileSync(CURRENT_PTR, "utf8").trim();
    assert.equal(ptr, logFile, ".current should point to the newly created log file");
  } finally {
    cleanupTestLogs([logFile]);
  }
});

test("getActiveLogFile returns the path written by initLogFile", () => {
  const logFile = initLogFile();
  try {
    assert.equal(getActiveLogFile(), logFile);
  } finally {
    cleanupTestLogs([logFile]);
  }
});

test("getActiveLogFile returns null when .current is absent", () => {
  // Remove .current temporarily
  let savedContent: string | null = null;
  try {
    savedContent = fs.readFileSync(CURRENT_PTR, "utf8");
  } catch { /* didn't exist */ }

  try {
    fs.unlinkSync(CURRENT_PTR);
  } catch { /* already absent */ }

  try {
    assert.equal(getActiveLogFile(), null);
  } finally {
    // Restore .current if it existed before
    if (savedContent !== null) {
      fs.writeFileSync(CURRENT_PTR, savedContent, "utf8");
    }
  }
});

test("initLogFile rotates old logs, keeping at most 10", () => {
  // Use an isolated temp directory so the running server's open log file
  // in the real logs/ dir cannot interfere with the count.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-rotate-test-"));

  // Create 10 dummy .log files with staggered mtimes (oldest first)
  const dummies: string[] = [];
  for (let i = 0; i < 10; i++) {
    const f = path.join(tmpDir, `dummy-rotate-${i}.log`);
    fs.writeFileSync(f, "", "utf8");
    const past = new Date(Date.now() - (11 - i) * 2000);
    fs.utimesSync(f, past, past);
    dummies.push(f);
  }

  initLogFile(tmpDir); // 11th file — oldest dummy should be deleted
  try {
    const allLogs = fs.readdirSync(tmpDir).filter(f => f.endsWith(".log"));
    assert.ok(allLogs.length <= 10, `Expected ≤10 log files, got ${allLogs.length}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
