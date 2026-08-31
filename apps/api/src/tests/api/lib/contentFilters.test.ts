import test from "node:test";
import assert from "node:assert/strict";
import { isBuildDir, isNonContentFile, isJunkDir, isJunkFile } from "@/lib/media/contentFilters.js";

test("isBuildDir matches dependency/build dirs, case-insensitively", () => {
  assert.equal(isBuildDir("node_modules"), true);
  assert.equal(isBuildDir(".git"), true);
  assert.equal(isBuildDir("dist"), true);
  assert.equal(isBuildDir("NODE_MODULES"), true);
  assert.equal(isBuildDir("lib"), true);
  assert.equal(isBuildDir("site-packages"), true);
  assert.equal(isBuildDir("vcpkg"), true);
  assert.equal(isBuildDir("bin"), true);
  assert.equal(isBuildDir("pkgs"), true);
});

test("isBuildDir matches package-manager caches/install trees", () => {
  for (const name of [".npm", ".yarn", ".pnpm-store", ".cargo", ".bundle", ".nuget", ".tox", ".eggs", "wheelhouse", "conda-meta"]) {
    assert.equal(isBuildDir(name), true, name);
  }
});

test("isBuildDir matches package-metadata dir suffixes (variable prefix)", () => {
  assert.equal(isBuildDir("pytest-8.3.2.dist-info"), true);
  assert.equal(isBuildDir("requests.egg-info"), true);
  assert.equal(isBuildDir("Pillow-10.0.0.dist-info"), true); // case-insensitive
  assert.equal(isBuildDir("numpy-1.26.egg"), true);
  assert.equal(isBuildDir("my-distinfo-notes"), false); // suffix must be the real ".dist-info"
});

test("isBuildDir matches temp/cache dirs, case-insensitively", () => {
  for (const name of ["temp", "tmp", ".temp", ".tmp", "cache", "caches", "TEMP", "Cache"]) {
    assert.equal(isBuildDir(name), true, name);
  }
});

test("isBuildDir leaves real content folders alone", () => {
  assert.equal(isBuildDir("Documents"), false);
  assert.equal(isBuildDir("Photos"), false);
  assert.equal(isBuildDir("my-node-stuff"), false); // substring must not match
});

test("isNonContentFile blocks unknown/binary extensions and extension-less files", () => {
  // compiled / binary
  for (const name of ["app.js", "main.ts", "lib.py", "tool.dll", "a.exe", "x.wasm", "config.toml", "bundle.map"]) {
    assert.equal(isNonContentFile(name), true, name);
  }
  // extension-less: hash blobs, makefiles, etc. — all filtered
  assert.equal(isNonContentFile("1599551814c141acd0c4a3c4a0ff83f4c4e3026d"), true); // Minecraft SHA1 blob
  assert.equal(isNonContentFile("Makefile"), true);
  assert.equal(isNonContentFile("README"), true);
  assert.equal(isNonContentFile(".gitignore"), true); // leading-dot only → no extension
});

test("isNonContentFile passes documents, images, media, and content-text", () => {
  for (const name of ["scan.pdf", "photo.jpg", "image.png", "report.docx", "notes.md", "data.csv", "page.html", "clip.mp4", "readme.txt", "archive.tar.gz"]) {
    assert.equal(isNonContentFile(name), false, name);
  }
});

test("isJunkDir matches OS/system dirs, case-insensitively", () => {
  for (const name of ["$RECYCLE.BIN", "System Volume Information", ".Trashes", "__MACOSX", ".Spotlight-V100", ".fseventsd", "lost+found"]) {
    assert.equal(isJunkDir(name), true, name);
  }
  assert.equal(isJunkDir("Documents"), false);
});

test("isJunkDir matches per-uid Linux trash by prefix", () => {
  assert.equal(isJunkDir(".Trash-1000"), true);
  assert.equal(isJunkDir(".trash-0"), true);
  assert.equal(isJunkDir(".trashcan"), false);
});

test("isJunkFile matches OS metadata, temp, and backup artifacts", () => {
  for (const name of ["Thumbs.db", "desktop.ini", ".DS_Store", "~$report.docx", "._foo", "draft.tmp", "movie.crdownload", "notes.txt~", ".main.swp", "backup.zip.driveupload", "video.mp4.opdownload"]) {
    assert.equal(isJunkFile(name), true, name);
  }
});

test("isJunkFile leaves real content alone", () => {
  for (const name of ["photo.jpg", "doc.pdf", "report.docx", "notes.md", "data.db", "report~final.pdf"]) {
    assert.equal(isJunkFile(name), false, name);
  }
});
