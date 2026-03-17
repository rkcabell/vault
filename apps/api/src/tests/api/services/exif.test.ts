import test from "node:test";
import assert from "node:assert/strict";
import { parseExif } from "@/services/media/metadata/image/exif.js";

// ── Binary builder helpers ────────────────────────────────────────────────────
//
// EXIF layout (all offsets absolute unless noted):
//   [0..5]   "Exif\0\0"
//   [6..7]   "II" (LE) or "MM" (BE)
//   [8..9]   TIFF magic (42)
//   [10..13] IFD0 offset from tiffStart (= 6)
//   [14..]   IFD0 data
//
// Each IFD: 2-byte count, count × 12-byte entries, 4-byte next-IFD (0)
// Each entry: tag(2) type(2) count(4) value-or-offset(4)
// Values ≤ 4 bytes are stored inline; larger ones are at tiffStart + offset.

const TIFF_START = 6;
const IFD0_ABS = 14; // tiffStart + 8

const TYPE_SIZE: Record<number, number> = {
  1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8,
};

type RawTag = { tag: number; type: number; count: number; payload: Buffer };

function asciiTag(tag: number, s: string): RawTag {
  const payload = Buffer.from(s + "\0", "ascii");
  return { tag, type: 2, count: payload.length, payload };
}
function shortTag(tag: number, value: number): RawTag {
  const payload = Buffer.alloc(2);
  payload.writeUInt16LE(value, 0);
  return { tag, type: 3, count: 1, payload };
}
function longTag(tag: number, value: number): RawTag {
  const payload = Buffer.alloc(4);
  payload.writeUInt32LE(value, 0);
  return { tag, type: 4, count: 1, payload };
}
function rationalTag(tag: number, vals: Array<[number, number]>): RawTag {
  const payload = Buffer.alloc(vals.length * 8);
  vals.forEach(([n, d], i) => {
    payload.writeUInt32LE(n, i * 8);
    payload.writeUInt32LE(d, i * 8 + 4);
  });
  return { tag, type: 5, count: vals.length, payload };
}

/**
 * Build a complete little-endian EXIF buffer.
 *
 * ifd0Extra: tags to include in IFD0.
 * nestedIfds: sub-IFDs referenced from IFD0 via a pointer tag.
 *   The builder allocates their space after IFD0, writes their entries, and
 *   injects a LONG pointer tag into IFD0 automatically.
 */
function buildExifLE(
  ifd0Extra: RawTag[],
  nestedIfds: Array<{ pointerTag: number; entries: RawTag[] }> = [],
): Buffer {
  // Pointer stubs for nested IFDs (offset patched later)
  const pointerStubs = nestedIfds.map(n => longTag(n.pointerTag, 0));
  const allIfd0 = [...ifd0Extra, ...pointerStubs];

  const ifd0Count = allIfd0.length;
  const ifd0EndAbs = IFD0_ABS + 2 + ifd0Count * 12 + 4;
  let cursor = ifd0EndAbs;

  // Resolve external data positions for IFD0 entries
  type Resolved = RawTag & { extAbs: number };
  const resolvedIfd0: Resolved[] = allIfd0.map(e => {
    const byteLen = (TYPE_SIZE[e.type] ?? 1) * e.count;
    if (byteLen <= 4) return { ...e, extAbs: -1 };
    const extAbs = cursor;
    cursor += byteLen;
    return { ...e, extAbs };
  });

  // Resolve nested IFDs
  type NestedResolved = { absStart: number; entries: Resolved[] };
  const nestedResolved: NestedResolved[] = nestedIfds.map((n, ni) => {
    const absStart = cursor;
    const nestedIfdSize = 2 + n.entries.length * 12 + 4;
    cursor += nestedIfdSize;

    const entries: Resolved[] = n.entries.map(e => {
      const byteLen = (TYPE_SIZE[e.type] ?? 1) * e.count;
      if (byteLen <= 4) return { ...e, extAbs: -1 };
      const extAbs = cursor;
      cursor += byteLen;
      return { ...e, extAbs };
    });

    // Patch the IFD0 pointer stub
    const stub = resolvedIfd0[ifd0Extra.length + ni]!;
    stub.payload.writeUInt32LE(absStart - TIFF_START, 0);

    return { absStart, entries };
  });

  const buf = Buffer.alloc(cursor, 0);

  // EXIF + TIFF header
  buf.write("Exif\0\0", 0, "ascii");
  buf.write("II", TIFF_START, "ascii");
  buf.writeUInt16LE(42, TIFF_START + 2);
  buf.writeUInt32LE(IFD0_ABS - TIFF_START, TIFF_START + 4); // = 8

  // IFD0
  buf.writeUInt16LE(ifd0Count, IFD0_ABS);
  writeIfdEntries(buf, IFD0_ABS, resolvedIfd0);

  // Nested IFDs
  nestedResolved.forEach(({ absStart, entries }) => {
    buf.writeUInt16LE(entries.length, absStart);
    writeIfdEntries(buf, absStart, entries);
  });

  return buf;
}

function writeIfdEntries(buf: Buffer, ifdAbs: number, entries: Array<{ tag: number; type: number; count: number; payload: Buffer; extAbs: number }>) {
  entries.forEach((e, i) => {
    const eAbs = ifdAbs + 2 + i * 12;
    buf.writeUInt16LE(e.tag, eAbs);
    buf.writeUInt16LE(e.type, eAbs + 2);
    buf.writeUInt32LE(e.count, eAbs + 4);
    const byteLen = (TYPE_SIZE[e.type] ?? 1) * e.count;
    if (byteLen <= 4) {
      e.payload.copy(buf, eAbs + 8);
    } else {
      buf.writeUInt32LE(e.extAbs - TIFF_START, eAbs + 8);
      e.payload.copy(buf, e.extAbs);
    }
  });
  // next IFD = 0 (already zeroed)
}

// ── Invalid input ─────────────────────────────────────────────────────────────

test("parseExif: returns null for buffer shorter than 14 bytes", () => {
  assert.equal(parseExif(Buffer.alloc(13, 0)), null);
  assert.equal(parseExif(Buffer.alloc(0)), null);
});

test("parseExif: returns null when header is not Exif\\0\\0", () => {
  const buf = Buffer.alloc(20, 0);
  buf.write("JFIF\0\0", 0, "ascii");
  assert.equal(parseExif(buf), null);
});

// ── Empty IFD ─────────────────────────────────────────────────────────────────

test("parseExif: all fields null for empty IFD0", () => {
  const buf = buildExifLE([]);
  const result = parseExif(buf);
  assert.ok(result !== null);
  assert.equal(result.make, null);
  assert.equal(result.model, null);
  assert.equal(result.iso, null);
  assert.equal(result.orientation, null);
  assert.equal(result.gps, null);
});

// ── ASCII tags ────────────────────────────────────────────────────────────────

test("parseExif: reads Make inline (≤4 chars)", () => {
  // "Cam" → "Cam\0" = 4 bytes, fits inline
  const buf = buildExifLE([asciiTag(0x010f, "Cam")]);
  const result = parseExif(buf);
  assert.equal(result?.make, "Cam");
});

test("parseExif: reads Make from external offset (>4 chars)", () => {
  const buf = buildExifLE([asciiTag(0x010f, "Canon")]);
  const result = parseExif(buf);
  assert.equal(result?.make, "Canon");
});

test("parseExif: reads Make and Model together", () => {
  const buf = buildExifLE([
    asciiTag(0x010f, "Nikon"),
    asciiTag(0x0110, "D850"),
  ]);
  const result = parseExif(buf);
  assert.equal(result?.make, "Nikon");
  assert.equal(result?.model, "D850");
});

// ── SHORT / orientation ───────────────────────────────────────────────────────

test("parseExif: reads Orientation SHORT inline", () => {
  const buf = buildExifLE([shortTag(0x0112, 6)]);
  const result = parseExif(buf);
  assert.equal(result?.orientation, 6);
});

// ── ExifIFD sub-directory ─────────────────────────────────────────────────────

test("parseExif: reads ISO from ExifIFD sub-directory", () => {
  const buf = buildExifLE(
    [shortTag(0x0112, 1)],          // IFD0: orientation (to keep IFD0 non-trivial)
    [{ pointerTag: 0x8769, entries: [shortTag(0x8827, 800)] }],
  );
  const result = parseExif(buf);
  assert.equal(result?.iso, 800);
  assert.equal(result?.orientation, 1);
});

test("parseExif: reads exposureTime rational from ExifIFD", () => {
  // 1/200 s → numerator=1, denominator=200
  const buf = buildExifLE(
    [],
    [{ pointerTag: 0x8769, entries: [rationalTag(0x829a, [[1, 200]])] }],
  );
  const result = parseExif(buf);
  assert.ok(result?.exposureTime !== null);
  assert.ok(Math.abs((result?.exposureTime ?? 0) - 0.005) < 1e-9);
});

// ── GPS sub-directory ─────────────────────────────────────────────────────────

test("parseExif: reads GPS latitude and longitude", () => {
  // lat = 48° N, lon = 2° E
  const buf = buildExifLE(
    [],
    [{
      pointerTag: 0x8825,
      entries: [
        asciiTag(0x0001, "N"),                       // latRef
        rationalTag(0x0002, [[48, 1], [0, 1], [0, 1]]), // lat
        asciiTag(0x0003, "E"),                       // lonRef
        rationalTag(0x0004, [[2, 1], [0, 1], [0, 1]]),  // lon
      ],
    }],
  );
  const result = parseExif(buf);
  assert.ok(result?.gps !== null);
  assert.equal(result?.gps?.latitude, 48);
  assert.equal(result?.gps?.longitude, 2);
  assert.equal(result?.gps?.altitude, null);
});

test("parseExif: negates latitude for S hemisphere and longitude for W", () => {
  // lat = 33° 52' 0\" S ≈ -33.866…, lon = 151° 12' 0\" W ≈ -151.2
  const buf = buildExifLE(
    [],
    [{
      pointerTag: 0x8825,
      entries: [
        asciiTag(0x0001, "S"),
        rationalTag(0x0002, [[33, 1], [52, 1], [0, 1]]),
        asciiTag(0x0003, "W"),
        rationalTag(0x0004, [[151, 1], [12, 1], [0, 1]]),
      ],
    }],
  );
  const result = parseExif(buf);
  assert.ok((result?.gps?.latitude ?? 0) < 0);
  assert.ok((result?.gps?.longitude ?? 0) < 0);
});

test("parseExif: GPS is null when latRef or lonRef is missing", () => {
  // Only lat coordinates, no latRef/lonRef
  const buf = buildExifLE(
    [],
    [{
      pointerTag: 0x8825,
      entries: [
        rationalTag(0x0002, [[48, 1], [0, 1], [0, 1]]),
        rationalTag(0x0004, [[2, 1], [0, 1], [0, 1]]),
      ],
    }],
  );
  const result = parseExif(buf);
  assert.equal(result?.gps, null);
});

// ── Big-endian (MM) ───────────────────────────────────────────────────────────

test("parseExif: parses big-endian (MM) EXIF correctly", () => {
  // Build a BE buffer manually: Orientation = 8
  const buf = Buffer.alloc(32, 0);
  buf.write("Exif\0\0", 0, "ascii");
  buf.write("MM", TIFF_START, "ascii");
  buf.writeUInt16BE(42, TIFF_START + 2);
  buf.writeUInt32BE(8, TIFF_START + 4); // IFD0 at tiffStart+8 = 14
  buf.writeUInt16BE(1, IFD0_ABS);       // 1 entry
  // Orientation entry at 16
  buf.writeUInt16BE(0x0112, 16);
  buf.writeUInt16BE(3, 18);             // SHORT
  buf.writeUInt32BE(1, 20);             // count = 1
  buf.writeUInt16BE(8, 24);             // value = 8 (inline BE)
  // next IFD = 0 at 28

  const result = parseExif(buf);
  assert.equal(result?.orientation, 8);
});

// ── Combined: Make + Orientation + ExifIFD ────────────────────────────────────

test("parseExif: combines IFD0 tags with ExifIFD in one buffer", () => {
  const buf = buildExifLE(
    [
      asciiTag(0x010f, "Sony"),
      asciiTag(0x0110, "A7R"),
      shortTag(0x0112, 1),
    ],
    [{
      pointerTag: 0x8769,
      entries: [
        shortTag(0x8827, 3200),         // ISO
        rationalTag(0x829d, [[28, 10]]), // f/2.8
      ],
    }],
  );
  const result = parseExif(buf);
  assert.equal(result?.make, "Sony");
  assert.equal(result?.model, "A7R");
  assert.equal(result?.orientation, 1);
  assert.equal(result?.iso, 3200);
  assert.ok(Math.abs((result?.fNumber ?? 0) - 2.8) < 1e-9);
});
