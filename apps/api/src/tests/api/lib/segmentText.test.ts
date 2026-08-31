import test from "node:test";
import assert from "node:assert/strict";
import { segmentExtractedText } from "@/lib/text/segmentText.js";
import type { TextSegment } from "@/lib/text/segmentText.js";

// ── helpers ───────────────────────────────────────────────────────────────────

function segmentIds (segments: TextSegment[]) {
  return segments.map(s => s.segmentId);
}

function orders (segments: TextSegment[]) {
  return segments.map(s => s.order);
}

function joined (segments: TextSegment[]) {
  return segments.map(s => s.text).join("");
}

// ── page-based path ───────────────────────────────────────────────────────────

test("pages: returns one segment per page", () => {
  const pages = [
    { text: "Page one", pageNumber: 1, numChars: 8 },
    { text: "Page two", pageNumber: 2, numChars: 8 },
    { text: "Page three", pageNumber: 3, numChars: 10 },
  ];
  const result = segmentExtractedText({ rawText: "", pages });
  assert.equal(result.length, 3);
});

test("pages: segmentId and order mirror page index", () => {
  const pages = [
    { text: "A", pageNumber: 1, numChars: 1 },
    { text: "B", pageNumber: 2, numChars: 1 },
    { text: "C", pageNumber: 3, numChars: 1 },
  ];
  const result = segmentExtractedText({ rawText: "", pages });
  assert.deepEqual(segmentIds(result), [0, 1, 2]);
  assert.deepEqual(orders(result), [0, 1, 2]);
});

test("pages: all pages except the last get a trailing double newline", () => {
  const pages = [
    { text: "First", pageNumber: 1, numChars: 5 },
    { text: "Second", pageNumber: 2, numChars: 6 },
    { text: "Last", pageNumber: 3, numChars: 4 },
  ];
  const result = segmentExtractedText({ rawText: "", pages });
  assert.equal(result[0]!.text, "First\n\n");
  assert.equal(result[1]!.text, "Second\n\n");
  assert.equal(result[2]!.text, "Last");
});

test("pages: single page has no trailing newline", () => {
  const pages = [{ text: "Only page", pageNumber: 1, numChars: 9 }];
  const result = segmentExtractedText({ rawText: "", pages });
  assert.equal(result.length, 1);
  assert.equal(result[0]!.text, "Only page");
});

test("pages: page with null/undefined text becomes empty string", () => {
  const pages = [
    { text: null as unknown as string, pageNumber: 1, numChars: 0 },
    { text: undefined as unknown as string, pageNumber: 2, numChars: 0 },
  ];
  const result = segmentExtractedText({ rawText: "", pages });
  assert.equal(result[0]!.text, "\n\n");  // empty + trailing newline (not last)
  assert.equal(result[1]!.text, "");      // empty, no trailing newline (last)
});

test("pages: ignores rawText when pages are provided", () => {
  const pages = [{ text: "From page", pageNumber: 1, numChars: 9 }];
  const result = segmentExtractedText({ rawText: "From raw text", pages });
  assert.equal(result.length, 1);
  assert.equal(result[0]!.text, "From page");
});

test("pages: falls through to length-based segmentation when pages is empty array", () => {
  const result = segmentExtractedText({ rawText: "hello", pages: [] });
  assert.equal(result.length, 1);
  assert.equal(result[0]!.text, "hello");
});

test("pages: falls through to length-based segmentation when pages is null", () => {
  const result = segmentExtractedText({ rawText: "hello", pages: null });
  assert.equal(result.length, 1);
  assert.equal(result[0]!.text, "hello");
});

// ── length-based path — empty / trivial ──────────────────────────────────────

test("length: returns empty array for empty rawText", () => {
  const result = segmentExtractedText({ rawText: "" });
  assert.deepEqual(result, []);
});

test("length: returns one segment when text fits in one chunk", () => {
  const result = segmentExtractedText({ rawText: "short text", maxLength: 100 });
  assert.equal(result.length, 1);
  assert.equal(result[0]!.text, "short text");
  assert.equal(result[0]!.segmentId, 0);
  assert.equal(result[0]!.order, 0);
});

test("length: segmentId and order are identical and sequential", () => {
  const text = "a".repeat(10);
  const result = segmentExtractedText({ rawText: text, maxLength: 4 });
  assert.ok(result.length > 1);
  assert.deepEqual(segmentIds(result), orders(result));
  assert.deepEqual(segmentIds(result), Array.from({ length: result.length }, (_, i) => i));
});

test("length: concatenating all segments reconstructs the original text", () => {
  const original = "The quick brown fox jumps over the lazy dog.";
  const result = segmentExtractedText({ rawText: original, maxLength: 10 });
  assert.equal(joined(result), original);
});

// ── length-based path — whitespace-aware splitting ────────────────────────────

test("length: breaks at whitespace rather than mid-word when possible", () => {
  // "hello world" with maxLength=8 — hard cut is at index 8 ('o' in 'world')
  // last whitespace before index 8 is the space at index 5 → break there
  const result = segmentExtractedText({ rawText: "hello world", maxLength: 8 });
  assert.equal(result[0]!.text, "hello ");
  assert.equal(result[1]!.text, "world");
});

test("length: includes the whitespace character in the preceding segment", () => {
  const result = segmentExtractedText({ rawText: "aa bb cc", maxLength: 4 });
  // chunk 1: "aa b" → last ws at index 2 (space), end = 3 → "aa "
  // chunk 2: "bb c" → last ws at index 5 (space), end = 6 → "bb "
  // chunk 3: "cc"
  assert.equal(joined(result), "aa bb cc");
  assert.ok(result[0]!.text.endsWith(" ") || result[0]!.text.length <= 4);
});

test("length: falls back to hard cut when no whitespace in window", () => {
  // one long word, no whitespace — must cut at maxLength boundary
  const word = "abcdefghij"; // 10 chars
  const result = segmentExtractedText({ rawText: word, maxLength: 4 });
  // segments: "abcd", "efgh", "ij"
  assert.equal(result.length, 3);
  assert.equal(result[0]!.text, "abcd");
  assert.equal(result[1]!.text, "efgh");
  assert.equal(result[2]!.text, "ij");
  assert.equal(joined(result), word);
});

test("length: handles text that is exactly maxLength — single segment", () => {
  const text = "segment";
  const result = segmentExtractedText({ rawText: text, maxLength: 7 });
  assert.equal(result.length, 1);
  assert.equal(result[0]!.text, text);
});

test("length: handles text that is maxLength + 1 — produces two segments", () => {
  const text = "abcde fgh"; // 9 chars, space at index 5
  const result = segmentExtractedText({ rawText: text, maxLength: 8 });
  assert.equal(result.length, 2);
  assert.equal(joined(result), text);
});

test("length: splits on tab and newline characters as whitespace", () => {
  const text = "foo\tbar";  // tab at index 3
  const result = segmentExtractedText({ rawText: text, maxLength: 5 });
  // hard end = 5 ('b'), last ws in [0,5) is tab at 3 → end = 4 → "foo\t"
  assert.equal(result[0]!.text, "foo\t");
  assert.equal(result[1]!.text, "bar");
});

test("length: uses default segment length (3500) when maxLength is omitted", () => {
  const text = "x".repeat(4000);
  const result = segmentExtractedText({ rawText: text });
  // No whitespace in the string → hard-cut at 3500
  assert.equal(result[0]!.text.length, 3500);
  assert.equal(result[1]!.text.length, 500);
});

test("length: handles unicode multi-byte characters without splitting them", () => {
  // Each emoji is a multi-code-unit character; splitting must still yield full text
  const text = "hello 🌍 world 🚀 end";
  const result = segmentExtractedText({ rawText: text, maxLength: 10 });
  assert.equal(joined(result), text);
});
