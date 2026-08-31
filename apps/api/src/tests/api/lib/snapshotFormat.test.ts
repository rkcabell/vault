import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { SIDECAR_SCHEMA_VERSION, type SidecarEntry } from "@vault/types";
import {
  SidecarFormatError,
  encodeEntry,
  encodeHeader,
  encodeTagLine,
  parseHeader,
  parseLine,
  readLines,
  snapshotBackupKey,
  snapshotKey,
} from "@/lib/sidecar/snapshotFormat.js";

const entry: SidecarEntry = {
  id: "m1",
  sourcePath: "E:/data/invoices/acme.pdf",
  filename: "acme.pdf",
  mimeType: "application/pdf",
  sizeBytes: 284119,
  contentHash: "sha256:9f86d0",
  title: "Acme invoice",
  titleIsUserEdited: true,
  tags: ["invoice", "type:pdf"],
  starred: true,
  starredAt: "2026-03-02T11:04:00.000Z",
  fileDate: "2024-11-08T00:00:00.000Z",
  bundles: ["Taxes 2024"],
  reminders: [{
    title: "Pay",
    note: null,
    dueAt: "2026-08-01T09:00:00.000Z",
    remindAt: "2026-07-30T09:00:00.000Z",
    timezone: "UTC",
    rrule: null,
    remindOffsetDays: 2,
  }],
};

/** Every optional field at the value toEntry would have rebuilt anyway. */
const plain: SidecarEntry = {
  id: "m2",
  sourcePath: "E:/data/notes/todo.txt",
  filename: "todo.txt",
  mimeType: "text/plain",
  sizeBytes: 812,
  contentHash: null,
  title: "todo",
  titleIsUserEdited: false,
  tags: [],
  starred: false,
  starredAt: null,
  fileDate: null,
  bundles: [],
  reminders: [],
};

test("snapshot keys are per user and the backup sits beside the snapshot", () => {
  assert.equal(snapshotKey("u1"), "sidecars/u1/library-snapshot.jsonl");
  assert.equal(snapshotBackupKey("u1"), "sidecars/u1/library-snapshot.jsonl.bak");
});

test("an entry survives a round trip unchanged", () => {
  const parsed = parseLine(encodeEntry(entry).trim());
  assert.equal(parsed.type, "entry");
  assert.deepEqual(parsed.type === "entry" ? parsed.entry : null, entry);
});

test("a default-valued entry omits the fields the reader rebuilds", () => {
  const line = JSON.parse(encodeEntry(plain)) as Record<string, unknown>;
  assert.deepEqual(Object.keys(line), ["id", "sourcePath", "filename", "mimeType", "sizeBytes", "title"]);
});

test("omitted fields come back as the reader's fallbacks", () => {
  const parsed = parseLine(encodeEntry(plain).trim());
  assert.equal(parsed.type, "entry");
  assert.deepEqual(parsed.type === "entry" ? parsed.entry : null, plain);
});

test("header carries the schema version and the row count", () => {
  const header = parseHeader(encodeHeader("u1", new Date("2026-07-31T10:00:00Z"), 4200).trim());
  assert.equal(header.kind, "vault-library-snapshot");
  assert.equal(header.schemaVersion, SIDECAR_SCHEMA_VERSION);
  assert.equal(header.userId, "u1");
  assert.equal(header.entries, 4200);
});

test("a header from a newer build is refused rather than half-understood", () => {
  const line = JSON.stringify({
    kind: "vault-library-snapshot",
    schemaVersion: SIDECAR_SCHEMA_VERSION + 1,
    userId: "u1",
    exportedAt: new Date().toISOString(),
    entries: 1,
  });
  assert.throws(() => parseHeader(line), SidecarFormatError);
});

test("a file that is not a snapshot is refused", () => {
  assert.throws(() => parseHeader('{"hello":"world"}'), SidecarFormatError);
  assert.throws(() => parseHeader("not json at all"), SidecarFormatError);
});

test("the tag line carries colour and origin, which no media row records", () => {
  const parsed = parseLine(encodeTagLine([
    { name: "invoice", color: "#ff0000", origin: "USER" },
    { name: "type:pdf", color: null, origin: "AUTO" },
  ]).trim());
  assert.equal(parsed.type, "tags");
  assert.deepEqual(parsed.type === "tags" ? parsed.tags : null, [
    { name: "invoice", color: "#ff0000", origin: "USER" },
    { name: "type:pdf", color: null, origin: "AUTO" },
  ]);
});

test("an entry with neither match key is dropped — it could never be reattached", () => {
  const orphan = JSON.stringify({ id: "m9", title: "Orphan", tags: ["x"] });
  assert.equal(parseLine(orphan).type, "unknown");
});

test("a contentHash-only entry is kept: a moved file still matches on bytes", () => {
  const parsed = parseLine(JSON.stringify({ id: "m9", contentHash: "sha256:abc" }));
  assert.equal(parsed.type, "entry");
  assert.equal(parsed.type === "entry" ? parsed.entry.sourcePath : "unset", null);
});

test("a malformed line costs one item, not the file", async () => {
  const file = [
    encodeHeader("u1", new Date(), 2),
    "{ this is not json\n",
    encodeEntry(entry),
  ].join("");

  const lines: string[] = [];
  for await (const line of readLines(Readable.from([file]))) lines.push(line);

  assert.equal(lines.length, 3);
  assert.equal(parseLine(lines[1]!).type, "unknown");
  assert.equal(parseLine(lines[2]!).type, "entry");
});

test("readLines splits across chunk boundaries and keeps an unterminated last line", async () => {
  const chunks = ['{"a":1}\n{"b', '":2}\n{"c":3}'];
  const lines: string[] = [];
  for await (const line of readLines(Readable.from(chunks))) lines.push(line);
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}', '{"c":3}']);
});

test("missing optional fields fall back rather than rejecting an older entry", () => {
  const parsed = parseLine(JSON.stringify({ id: "m2", sourcePath: "/a/b.txt" }));
  assert.equal(parsed.type, "entry");
  if (parsed.type !== "entry") return;
  assert.deepEqual(parsed.entry.tags, []);
  assert.deepEqual(parsed.entry.bundles, []);
  assert.deepEqual(parsed.entry.reminders, []);
  assert.equal(parsed.entry.starred, false);
  assert.equal(parsed.entry.titleIsUserEdited, false);
});
