import test from "node:test";
import assert from "node:assert/strict";
import { looksLikeHeic } from "@/lib/fileSignatures.js";

function makeFtypBuffer(brand: string): Buffer {
  const bytes = Buffer.alloc(16);
  // box size
  bytes[0] = 0x00;
  bytes[1] = 0x00;
  bytes[2] = 0x00;
  bytes[3] = 0x18;
  // "ftyp"
  bytes[4] = 0x66;
  bytes[5] = 0x74;
  bytes[6] = 0x79;
  bytes[7] = 0x70;
  bytes.write(brand, 8, 4, "ascii");
  return bytes;
}

test("looksLikeHeic detects HEIC/HEIF brands", () => {
  assert.equal(looksLikeHeic(makeFtypBuffer("heic")), true);
  assert.equal(looksLikeHeic(makeFtypBuffer("heix")), true);
  assert.equal(looksLikeHeic(makeFtypBuffer("mif1")), true);
});

test("looksLikeHeic rejects non-HEIC brands", () => {
  assert.equal(looksLikeHeic(makeFtypBuffer("isom")), false);
  assert.equal(looksLikeHeic(makeFtypBuffer("mp42")), false);
  assert.equal(looksLikeHeic(Buffer.from("not-a-real-file")), false);
});
