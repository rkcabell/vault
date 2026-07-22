import test from "node:test";
import assert from "node:assert/strict";
import { evaluateRules, folderSegments, type TagRuleInput } from "@/lib/tags/rules/evaluateRules.js";
import { resolveFileDate } from "@/lib/tags/rules/fileDate.js";
import { DEFAULT_TAG_RULES } from "@/lib/tags/rules/defaults.js";

const defaultRules: TagRuleInput[] = DEFAULT_TAG_RULES.map(r => ({ ...r, enabled: true }));

function rule (partial: Partial<TagRuleInput> & Pick<TagRuleInput, "source" | "tagTemplate">): TagRuleInput {
  return { matcher: {}, priority: 0, enabled: true, ...partial };
}

// ── built-in source axis ──────────────────────────────────────────────────────

test("evaluateRules: emits source:<ingest> with no rules at all", () => {
  assert.deepEqual(evaluateRules([], { filename: "a.pdf", ingest: "upload" }), ["source:upload"]);
  assert.deepEqual(evaluateRules([], { filename: "a.pdf", ingest: "index" }), ["source:index"]);
  assert.deepEqual(evaluateRules([], { filename: "a.pdf", ingest: "unpacked" }), ["source:unpacked"]);
});

test("evaluateRules: omits the source axis when ingest is unknown", () => {
  assert.deepEqual(evaluateRules([], { filename: "a.pdf" }), []);
});

// ── MIME rules ────────────────────────────────────────────────────────────────

test("MIME rule: applies the type tag from the MIME label", () => {
  const tags = evaluateRules([rule({ source: "MIME", tagTemplate: "type:{value}" })], {
    filename: "photo.jpg",
    mimeType: "image/jpeg",
  });
  assert.deepEqual(tags, ["type:jpg"]);
});

test("MIME rule: falls back to the extension for unknown MIME types", () => {
  const tags = evaluateRules([rule({ source: "MIME", tagTemplate: "type:{value}" })], {
    filename: "file.abc",
    mimeType: "application/x-unknown",
  });
  assert.deepEqual(tags, ["type:abc"]);
});

test("MIME rule: mimePrefixes filter restricts which files match", () => {
  const r = rule({ source: "MIME", matcher: { mimePrefixes: ["image/"] }, tagTemplate: "img" });
  assert.deepEqual(evaluateRules([r], { filename: "a.jpg", mimeType: "image/jpeg" }), ["img"]);
  assert.deepEqual(evaluateRules([r], { filename: "a.pdf", mimeType: "application/pdf" }), []);
});

// ── EXTENSION rules ───────────────────────────────────────────────────────────

test("EXTENSION rule: tags the raw extension; skips extension-less names", () => {
  const r = rule({ source: "EXTENSION", tagTemplate: "ext:{value}" });
  assert.deepEqual(evaluateRules([r], { filename: "notes.TXT" }), ["ext:txt"]);
  assert.deepEqual(evaluateRules([r], { filename: "README" }), []);
});

test("EXTENSION rule: extensions list restricts matches", () => {
  const r = rule({ source: "EXTENSION", matcher: { extensions: ["pdf"] }, tagTemplate: "paper" });
  assert.deepEqual(evaluateRules([r], { filename: "a.pdf" }), ["paper"]);
  assert.deepEqual(evaluateRules([r], { filename: "a.jpg" }), []);
});

// ── FILENAME rules ────────────────────────────────────────────────────────────

test("FILENAME rule: fixed tag on pattern match (case-insensitive)", () => {
  const r = rule({ source: "FILENAME", matcher: { pattern: "invoice" }, tagTemplate: "invoice" });
  assert.deepEqual(evaluateRules([r], { filename: "INVOICE-2023.pdf" }), ["invoice"]);
  assert.deepEqual(evaluateRules([r], { filename: "receipt.pdf" }), []);
});

test("FILENAME rule: first capture group becomes {value}", () => {
  const r = rule({ source: "FILENAME", matcher: { pattern: "^(\\w+)-" }, tagTemplate: "doc:{value}" });
  assert.deepEqual(evaluateRules([r], { filename: "Invoice-march.pdf" }), ["doc:invoice"]);
});

test("FILENAME rule: {value} template with no capture group is skipped", () => {
  const r = rule({ source: "FILENAME", matcher: { pattern: "invoice" }, tagTemplate: "doc:{value}" });
  assert.deepEqual(evaluateRules([r], { filename: "invoice.pdf" }), []);
});

test("FILENAME rule: uncompilable stored pattern is skipped, never throws", () => {
  const r = rule({ source: "FILENAME", matcher: { pattern: "([" }, tagTemplate: "x" });
  assert.deepEqual(evaluateRules([r], { filename: "a.pdf" }), []);
});

// ── PATH_SEGMENT rules ────────────────────────────────────────────────────────

test("PATH_SEGMENT rule: one folder tag per segment under the index root", () => {
  const r = rule({ source: "PATH_SEGMENT", tagTemplate: "folder:{value}" });
  const tags = evaluateRules([r], {
    filename: "a.pdf",
    sourcePath: "E:\\Docs\\Scans\\Receipts\\a.pdf",
    indexRoots: ["E:\\Docs"],
  });
  assert.deepEqual(tags, ["folder:scans", "folder:receipts"]);
});

test("PATH_SEGMENT rule: maxDepth caps the segments", () => {
  const r = rule({ source: "PATH_SEGMENT", matcher: { maxDepth: 1 }, tagTemplate: "folder:{value}" });
  const tags = evaluateRules([r], {
    filename: "a.pdf",
    sourcePath: "/data/scans/receipts/2023/a.pdf",
    indexRoots: ["/data"],
  });
  assert.deepEqual(tags, ["folder:scans"]);
});

test("PATH_SEGMENT rule: no tags for files directly in the root or outside every root", () => {
  const r = rule({ source: "PATH_SEGMENT", tagTemplate: "folder:{value}" });
  assert.deepEqual(
    evaluateRules([r], { filename: "a.pdf", sourcePath: "/data/a.pdf", indexRoots: ["/data"] }),
    [],
  );
  assert.deepEqual(
    evaluateRules([r], { filename: "a.pdf", sourcePath: "/elsewhere/x/a.pdf", indexRoots: ["/data"] }),
    [],
  );
});

test("folderSegments: case-insensitive root matching, mixed separators", () => {
  assert.deepEqual(
    folderSegments("e:\\docs\\Scans\\a.pdf", ["E:/Docs"]),
    ["Scans"],
  );
});

test("PATH_SEGMENT rule: segment names are sanitized into valid tags", () => {
  const r = rule({ source: "PATH_SEGMENT", tagTemplate: "folder:{value}" });
  const tags = evaluateRules([r], {
    filename: "a.pdf",
    sourcePath: "/data/My Tax Docs (2023)/a.pdf",
    indexRoots: ["/data"],
  });
  assert.deepEqual(tags, ["folder:my-tax-docs-2023"]);
});

// ── FILE_DATE rules ───────────────────────────────────────────────────────────

test("FILE_DATE rule: year and month granularity", () => {
  const rules = [
    rule({ source: "FILE_DATE", matcher: { granularity: "year" }, tagTemplate: "year:{value}" }),
    rule({ source: "FILE_DATE", matcher: { granularity: "month" }, tagTemplate: "month:{value}", priority: 1 }),
  ];
  const tags = evaluateRules(rules, {
    filename: "a.jpg",
    fileDate: new Date(Date.UTC(2023, 5, 15)),
  });
  assert.deepEqual(tags, ["year:2023", "month:2023-06"]);
});

test("FILE_DATE rule: no date fact → no tag; corrupt EXIF year is skipped", () => {
  const r = rule({ source: "FILE_DATE", matcher: { granularity: "year" }, tagTemplate: "year:{value}" });
  assert.deepEqual(evaluateRules([r], { filename: "a.jpg" }), []);
  assert.deepEqual(evaluateRules([r], { filename: "a.jpg", fileDate: new Date("0000-01-01") }), []);
});

// ── SIZE rules ────────────────────────────────────────────────────────────────

test("SIZE rule: fixed tag when the size is inside the bounds", () => {
  const r = rule({ source: "SIZE", matcher: { minBytes: 1024 }, tagTemplate: "large" });
  assert.deepEqual(evaluateRules([r], { filename: "a.bin", sizeBytes: 4096 }), ["large"]);
  assert.deepEqual(evaluateRules([r], { filename: "a.bin", sizeBytes: 10 }), []);
  assert.deepEqual(evaluateRules([r], { filename: "a.bin" }), []);
});

// ── rule mechanics ────────────────────────────────────────────────────────────

test("evaluateRules: disabled rules are skipped", () => {
  const r = rule({ source: "MIME", tagTemplate: "type:{value}", enabled: false });
  assert.deepEqual(evaluateRules([r], { filename: "a.pdf", mimeType: "application/pdf" }), []);
});

test("evaluateRules: rules evaluate in priority order and dedupe output", () => {
  const rules = [
    rule({ source: "EXTENSION", tagTemplate: "b:{value}", priority: 10 }),
    rule({ source: "EXTENSION", tagTemplate: "a:{value}", priority: 0 }),
    rule({ source: "EXTENSION", tagTemplate: "a:{value}", priority: 20 }), // duplicate output
  ];
  const tags = evaluateRules(rules, { filename: "x.pdf" });
  assert.deepEqual(tags, ["a:pdf", "b:pdf"]);
});

test("evaluateRules: an invalid stored matcher skips the rule, never throws", () => {
  const r = rule({ source: "FILE_DATE", matcher: { granularity: "decade" }, tagTemplate: "year:{value}" });
  assert.deepEqual(evaluateRules([r], { filename: "a.jpg", fileDate: new Date() }), []);
});

test("evaluateRules: a template that normalizes to an invalid tag is skipped", () => {
  // Two colons after substitution → invalid namespaced tag.
  const r = rule({ source: "EXTENSION", tagTemplate: "a:b:{value}" });
  assert.deepEqual(evaluateRules([r], { filename: "x.pdf" }), []);
});

test("evaluateRules: default rule set on an indexed file yields all four axes", () => {
  const tags = evaluateRules(defaultRules, {
    filename: "scan.pdf",
    mimeType: "application/pdf",
    sizeBytes: 1000,
    sourcePath: "/roots/taxes/2023/scan.pdf",
    indexRoots: ["/roots"],
    fileDate: new Date(Date.UTC(2023, 0, 3)),
    ingest: "index",
  });
  assert.deepEqual(tags, [
    "source:index",
    "type:pdf",
    "year:2023",
    "month:2023-01",
    "folder:taxes",
    "folder:2023",
  ]);
});

// ── resolveFileDate ───────────────────────────────────────────────────────────

test("resolveFileDate: EXIF capturedAt wins over PDF createdAt and mtime", () => {
  const d = resolveFileDate(
    { image: { capturedAt: "2020-05-01T10:00:00Z" }, pdf: { createdAt: "2021-01-01T00:00:00Z" } },
    Date.UTC(2022, 0, 1),
  );
  assert.equal(d?.getUTCFullYear(), 2020);
});

test("resolveFileDate: PDF createdAt beats mtime; mtime is the last resort", () => {
  const viaPdf = resolveFileDate({ pdf: { createdAt: "2021-03-01T00:00:00Z" } }, Date.UTC(2022, 0, 1));
  assert.equal(viaPdf?.getUTCFullYear(), 2021);
  const viaMtime = resolveFileDate(null, Date.UTC(2022, 5, 1));
  assert.equal(viaMtime?.getUTCFullYear(), 2022);
});

test("resolveFileDate: unparseable strings and missing facts give null", () => {
  assert.equal(resolveFileDate({ image: { capturedAt: "not-a-date" } }), null);
  assert.equal(resolveFileDate(null), null);
  assert.equal(resolveFileDate(undefined, 0), null);
});
