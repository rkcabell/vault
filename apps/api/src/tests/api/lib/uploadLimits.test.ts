import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyUploadKind,
  uploadLimitForKind,
  getUploadSizeError,
  PHOTO_UPLOAD_LIMIT_BYTES,
  DOCUMENT_UPLOAD_LIMIT_BYTES,
  HARD_UPLOAD_LIMIT_BYTES,
} from "@/lib/media/uploadLimits.js";

const MB = 1024 * 1024;

// ── classifyUploadKind — photo ────────────────────────────────────────────────

test("classifyUploadKind: image/* MIME types are photos", () => {
  assert.equal(classifyUploadKind("image/jpeg", "photo.jpg"), "photo");
  assert.equal(classifyUploadKind("image/png", "photo.png"), "photo");
  assert.equal(classifyUploadKind("image/webp", "photo.webp"), "photo");
  assert.equal(classifyUploadKind("image/heic", "photo.heic"), "photo");
  assert.equal(classifyUploadKind("image/gif", "photo.gif"), "photo");
});

test("classifyUploadKind: photo classification is case-insensitive on MIME", () => {
  assert.equal(classifyUploadKind("IMAGE/JPEG", "photo.jpg"), "photo");
  assert.equal(classifyUploadKind("Image/PNG", "photo.png"), "photo");
});

// ── classifyUploadKind — document via exact MIME ──────────────────────────────

test("classifyUploadKind: exact document MIME types are documents", () => {
  assert.equal(classifyUploadKind("application/pdf", "file.pdf"), "document");
  assert.equal(classifyUploadKind("application/msword", "file.doc"), "document");
  assert.equal(classifyUploadKind("application/rtf", "file.rtf"), "document");
  assert.equal(classifyUploadKind("application/vnd.ms-excel", "file.xls"), "document");
  assert.equal(classifyUploadKind("application/vnd.ms-powerpoint", "file.ppt"), "document");
  assert.equal(classifyUploadKind("text/csv", "file.csv"), "document");
  assert.equal(classifyUploadKind("text/plain", "file.txt"), "document");
  assert.equal(
    classifyUploadKind(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "file.docx",
    ),
    "document",
  );
  assert.equal(
    classifyUploadKind(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "file.xlsx",
    ),
    "document",
  );
  assert.equal(
    classifyUploadKind(
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "file.pptx",
    ),
    "document",
  );
});

// ── classifyUploadKind — document via MIME prefix ─────────────────────────────

test("classifyUploadKind: text/* MIME prefix classifies as document", () => {
  assert.equal(classifyUploadKind("text/html", "page.html"), "document");
  assert.equal(classifyUploadKind("text/markdown", "readme.md"), "document");
});

test("classifyUploadKind: application/vnd.openxmlformats-officedocument prefix classifies as document", () => {
  assert.equal(
    classifyUploadKind("application/vnd.openxmlformats-officedocument.custom", "file.bin"),
    "document",
  );
});

test("classifyUploadKind: document MIME classification is case-insensitive", () => {
  assert.equal(classifyUploadKind("APPLICATION/PDF", "file.pdf"), "document");
  assert.equal(classifyUploadKind("TEXT/PLAIN", "file.txt"), "document");
});

// ── classifyUploadKind — document via extension ───────────────────────────────

test("classifyUploadKind: document extensions classify as document when MIME is unknown", () => {
  assert.equal(classifyUploadKind("application/octet-stream", "file.pdf"), "document");
  assert.equal(classifyUploadKind("application/octet-stream", "file.docx"), "document");
  assert.equal(classifyUploadKind("application/octet-stream", "file.xlsx"), "document");
  assert.equal(classifyUploadKind("application/octet-stream", "file.pptx"), "document");
  assert.equal(classifyUploadKind("application/octet-stream", "file.txt"), "document");
  assert.equal(classifyUploadKind("application/octet-stream", "file.csv"), "document");
  assert.equal(classifyUploadKind("application/octet-stream", "file.rtf"), "document");
});

test("classifyUploadKind: extension matching is case-insensitive on filename", () => {
  assert.equal(classifyUploadKind("application/octet-stream", "FILE.PDF"), "document");
  assert.equal(classifyUploadKind("application/octet-stream", "Report.DOCX"), "document");
});

test("classifyUploadKind: extension uses the last dot in the filename", () => {
  assert.equal(classifyUploadKind("application/octet-stream", "my.report.pdf"), "document");
});

test("classifyUploadKind: filename with no extension and unknown MIME is other", () => {
  assert.equal(classifyUploadKind("application/octet-stream", "Makefile"), "other");
});

// ── classifyUploadKind — other ────────────────────────────────────────────────

test("classifyUploadKind: video files are other", () => {
  assert.equal(classifyUploadKind("video/mp4", "clip.mp4"), "other");
  assert.equal(classifyUploadKind("video/quicktime", "clip.mov"), "other");
});

test("classifyUploadKind: audio files are other", () => {
  assert.equal(classifyUploadKind("audio/mpeg", "track.mp3"), "other");
});

test("classifyUploadKind: unknown MIME with unknown extension is other", () => {
  assert.equal(classifyUploadKind("application/octet-stream", "archive.zip"), "other");
  assert.equal(classifyUploadKind("application/octet-stream", "binary.bin"), "other");
});

// ── uploadLimitForKind ────────────────────────────────────────────────────────

test("uploadLimitForKind: photo limit is 50 MB", () => {
  assert.equal(uploadLimitForKind("photo"), PHOTO_UPLOAD_LIMIT_BYTES);
  assert.equal(uploadLimitForKind("photo"), 50 * MB);
});

test("uploadLimitForKind: document limit is 250 MB", () => {
  assert.equal(uploadLimitForKind("document"), DOCUMENT_UPLOAD_LIMIT_BYTES);
  assert.equal(uploadLimitForKind("document"), 250 * MB);
});

test("uploadLimitForKind: other limit is 500 MB", () => {
  assert.equal(uploadLimitForKind("other"), HARD_UPLOAD_LIMIT_BYTES);
  assert.equal(uploadLimitForKind("other"), 500 * MB);
});

// ── getUploadSizeError ────────────────────────────────────────────────────────

test("getUploadSizeError: returns null when file is under limit", () => {
  assert.equal(
    getUploadSizeError({ filename: "photo.jpg", mimeType: "image/jpeg", sizeBytes: 1 * MB }),
    null,
  );
  assert.equal(
    getUploadSizeError({ filename: "file.pdf", mimeType: "application/pdf", sizeBytes: 100 * MB }),
    null,
  );
  assert.equal(
    getUploadSizeError({ filename: "clip.mp4", mimeType: "video/mp4", sizeBytes: 200 * MB }),
    null,
  );
});

test("getUploadSizeError: returns null exactly at the limit", () => {
  assert.equal(
    getUploadSizeError({
      filename: "photo.jpg",
      mimeType: "image/jpeg",
      sizeBytes: PHOTO_UPLOAD_LIMIT_BYTES,
    }),
    null,
  );
  assert.equal(
    getUploadSizeError({
      filename: "file.pdf",
      mimeType: "application/pdf",
      sizeBytes: DOCUMENT_UPLOAD_LIMIT_BYTES,
    }),
    null,
  );
});

test("getUploadSizeError: returns error message 1 byte over the photo limit", () => {
  const result = getUploadSizeError({
    filename: "photo.jpg",
    mimeType: "image/jpeg",
    sizeBytes: PHOTO_UPLOAD_LIMIT_BYTES + 1,
  });
  assert.ok(result !== null);
  assert.ok(result.includes("photo.jpg"));
  assert.ok(result.includes("50 MB"));
  assert.ok(result.includes("photos"));
});

test("getUploadSizeError: returns error message 1 byte over the document limit", () => {
  const result = getUploadSizeError({
    filename: "report.pdf",
    mimeType: "application/pdf",
    sizeBytes: DOCUMENT_UPLOAD_LIMIT_BYTES + 1,
  });
  assert.ok(result !== null);
  assert.ok(result.includes("report.pdf"));
  assert.ok(result.includes("250 MB"));
  assert.ok(result.includes("documents"));
});

test("getUploadSizeError: returns error message 1 byte over the hard limit for other", () => {
  const result = getUploadSizeError({
    filename: "clip.mp4",
    mimeType: "video/mp4",
    sizeBytes: HARD_UPLOAD_LIMIT_BYTES + 1,
  });
  assert.ok(result !== null);
  assert.ok(result.includes("clip.mp4"));
  assert.ok(result.includes("500 MB"));
  assert.ok(result.includes("files"));
});

test("getUploadSizeError: error message includes the exact filename", () => {
  const result = getUploadSizeError({
    filename: "my-vacation-photo.jpg",
    mimeType: "image/jpeg",
    sizeBytes: PHOTO_UPLOAD_LIMIT_BYTES + 1,
  });
  assert.ok(result?.includes("my-vacation-photo.jpg"));
});

test("getUploadSizeError: classifies via extension when MIME is octet-stream", () => {
  // .pdf extension → document → 250 MB limit
  const underLimit = getUploadSizeError({
    filename: "file.pdf",
    mimeType: "application/octet-stream",
    sizeBytes: 100 * MB,
  });
  assert.equal(underLimit, null);

  const overLimit = getUploadSizeError({
    filename: "file.pdf",
    mimeType: "application/octet-stream",
    sizeBytes: DOCUMENT_UPLOAD_LIMIT_BYTES + 1,
  });
  assert.ok(overLimit?.includes("250 MB"));
});
