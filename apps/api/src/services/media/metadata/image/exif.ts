import type { ImageGps } from "../types.js";

/**
 * Reads the camera, lens and GPS fields out of an image's EXIF block, without
 * an external library. Only the TIFF value types that common EXIF tags use are
 * decoded; an unknown type, and any read past the end of the buffer, comes back
 * as null instead of throwing.
 */

export type ParsedExif = {
  make?: string | null;
  model?: string | null;
  lens?: string | null;
  iso?: number | null;
  exposureTime?: number | null;
  fNumber?: number | null;
  focalLengthMm?: number | null;
  orientation?: number | null;
  colorSpace?: string | number | null;
  editedBy?: string | null;
  capturedAt?: string | null;
  gps?: ImageGps | null;
};

export type Rational = { numerator: number; denominator: number };

/**
 * Parses an EXIF block that opens with the Exif header, returning the camera,
 * lens and GPS fields. Null when that header is missing, malformed, or too
 * short to hold IFD0.
 */
export function parseExif (exif: Buffer): ParsedExif | null {
  if (exif.length < 14) return null;
  if (exif.toString("ascii", 0, 6) !== "Exif\0\0") return null;

  const tiffStart = 6;
  const endian = exif.toString("ascii", tiffStart, tiffStart + 2);
  const little = endian === "II";

  const firstIfdOffset = readUInt32(exif, tiffStart + 4, little);
  const ifd0 = readIfd(exif, tiffStart, tiffStart + firstIfdOffset, little);

  const exifIfdOffset = ifd0.tags.get(0x8769);
  const gpsIfdOffset = ifd0.tags.get(0x8825);

  const exifIfd = typeof exifIfdOffset === "number"
    ? readIfd(exif, tiffStart, tiffStart + exifIfdOffset, little)
    : null;
  const gpsIfd = typeof gpsIfdOffset === "number"
    ? readIfd(exif, tiffStart, tiffStart + gpsIfdOffset, little)
    : null;

  const make = ifd0.tags.get(0x010f);
  const model = ifd0.tags.get(0x0110);
  const software = ifd0.tags.get(0x0131);
  const orientation = ifd0.tags.get(0x0112);

  const lensMake = exifIfd?.tags.get(0xa433) ?? null;
  const lensModel = exifIfd?.tags.get(0xa434) ?? null;
  const lens = [lensMake, lensModel].filter(Boolean).join(" ").trim() || null;

  const iso = toNumber(exifIfd?.tags.get(0x8827));
  const exposureTime = rationalToNumber(toRational(exifIfd?.tags.get(0x829a)));
  const fNumber = rationalToNumber(toRational(exifIfd?.tags.get(0x829d)));
  const focalLengthMm = rationalToNumber(toRational(exifIfd?.tags.get(0x920a)));

  const rawColorSpace = exifIfd?.tags.get(0xa001);
  const colorSpace =
    typeof rawColorSpace === "string" || typeof rawColorSpace === "number" ? rawColorSpace : null;
  const capturedAt = toString(exifIfd?.tags.get(0x9003));

  const gps = gpsIfd ? parseGps(gpsIfd.tags) : null;

  return {
    make: toString(make),
    model: toString(model),
    lens: lens || null,
    iso,
    exposureTime,
    fNumber,
    focalLengthMm,
    orientation: toNumber(orientation),
    colorSpace,
    editedBy: toString(software),
    capturedAt,
    gps,
  };
}

/**
 * Reads a TIFF Image File Directory at `offset`. Each 12-byte entry holds a tag
 * (2 bytes), a type (2), a count (4), then a value or an offset (4).
 * `tiffStart` anchors the offsets of values too large to sit inline.
 */
function readIfd (
  buffer: Buffer,
  tiffStart: number,
  offset: number,
  little: boolean,
) {
  const tags = new Map<number, unknown>();
  if (offset + 2 > buffer.length) return { tags };

  const count = readUInt16(buffer, offset, little);
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset + 2 + i * 12;
    const tag = readUInt16(buffer, entryOffset, little);
    const type = readUInt16(buffer, entryOffset + 2, little);
    const valueCount = readUInt32(buffer, entryOffset + 4, little);
    const valueOffset = readUInt32(buffer, entryOffset + 8, little);
    const value = readExifValue(buffer, tiffStart, entryOffset, type, valueCount, valueOffset, little);
    if (value !== null && value !== undefined) {
      tags.set(tag, value);
    }
  }

  return { tags };
}

/**
 * Decodes one IFD entry's value according to its TIFF type id.
 *
 * A value of four bytes or fewer sits inline at `entryOffset + 8`; a longer one
 * sits at `tiffStart + valueOffset`. A single-component value is unwrapped from
 * its array, and multi-component values stay arrays. An unknown type, a count
 * of zero, and an out-of-bounds read all return null.
 */
function readExifValue (
  buffer: Buffer,
  tiffStart: number,
  entryOffset: number,
  type: number,
  count: number,
  valueOffset: number,
  little: boolean,
) {
  const typeSize = getExifTypeSize(type);
  if (!typeSize) return null;
  const byteLength = typeSize * count;

  const valueStart =
    byteLength <= 4 ? entryOffset + 8 : tiffStart + valueOffset;
  if (valueStart < 0 || valueStart + byteLength > buffer.length) return null;

  switch (type) {
    // Type 2 — ASCII: null-terminated string; strip trailing NUL bytes.
    case 2: {
      const raw = buffer.toString("ascii", valueStart, valueStart + byteLength);
      return raw.replace(/\0+$/, "");
    }
    // Type 3 — SHORT: unsigned 16-bit integer(s).
    case 3: {
      const values = [];
      for (let i = 0; i < count; i += 1) {
        values.push(readUInt16(buffer, valueStart + i * 2, little));
      }
      return count === 1 ? values[0] : values;
    }
    // Type 4 — LONG: unsigned 32-bit integer(s).
    case 4: {
      const values = [];
      for (let i = 0; i < count; i += 1) {
        values.push(readUInt32(buffer, valueStart + i * 4, little));
      }
      return count === 1 ? values[0] : values;
    }
    // Type 5 — RATIONAL: numerator then denominator, both unsigned 32-bit.
    case 5: {
      const values: Rational[] = [];
      for (let i = 0; i < count; i += 1) {
        const numerator = readUInt32(buffer, valueStart + i * 8, little);
        const denominator = readUInt32(buffer, valueStart + i * 8 + 4, little);
        values.push({ numerator, denominator });
      }
      return count === 1 ? values[0] : values;
    }
    // Type 7 — UNDEFINED: raw bytes, with a meaning the tag defines.
    case 7: {
      return buffer.subarray(valueStart, valueStart + byteLength);
    }
    // Type 9 — SLONG: signed 32-bit integer(s).
    case 9: {
      const values = [];
      for (let i = 0; i < count; i += 1) {
        values.push(readInt32(buffer, valueStart + i * 4, little));
      }
      return count === 1 ? values[0] : values;
    }
    // Type 10 — SRATIONAL: the same layout as RATIONAL, signed.
    case 10: {
      const values: Rational[] = [];
      for (let i = 0; i < count; i += 1) {
        const numerator = readInt32(buffer, valueStart + i * 8, little);
        const denominator = readInt32(buffer, valueStart + i * 8 + 4, little);
        values.push({ numerator, denominator });
      }
      return count === 1 ? values[0] : values;
    }
    // Types 1 (BYTE), 6 (SBYTE), 8 (SSHORT) and vendor extensions carry none of
    // the tags read here.
    default:
      return null;
  }
}

function getExifTypeSize (type: number) {
  switch (type) {
    case 1:
    case 2:
    case 7:
      return 1; // Byte, ASCII, Undefined
    case 3:
      return 2; // Short
    case 4:
    case 9:
      return 4; // Long, SLONG
    case 5:
    case 10:
      return 8; // Rational, SRational
    default:
      return 0; // Unknown
  }
}

/**
 * Converts the GPS IFD tags into decimal degrees. Null when a reference or a
 * coordinate tag is missing or invalid. Altitude is negated when GPSAltitudeRef
 * (0x0005) is 1, which means below sea level.
 */
function parseGps (tags: Map<number, unknown>): ImageGps | null {
  const latRef = toString(tags.get(0x0001));
  const lat = toRationalArray(tags.get(0x0002));
  const lonRef = toString(tags.get(0x0003));
  const lon = toRationalArray(tags.get(0x0004));
  const altRef = toNumber(tags.get(0x0005));
  const alt = rationalToNumber(toRational(tags.get(0x0006)));

  if (!latRef || !lonRef || !lat || !lon) return null;

  const latitude = rationalTripletToDecimal(lat, latRef === "S");
  const longitude = rationalTripletToDecimal(lon, lonRef === "W");
  if (latitude === null || longitude === null) return null;
  const altitude =
    typeof alt === "number"
      ? altRef === 1
        ? -alt
        : alt
      : null;

  return { latitude, longitude, altitude };
}

/**
 * Converts a [degrees, minutes, seconds] triplet to decimal degrees. Pass
 * `negative` for a south latitude or a west longitude.
 */
function rationalTripletToDecimal (values: Rational[], negative: boolean): number | null {
  const [deg, min, sec] = values;
  const degrees = rationalToNumber(deg);
  const minutes = rationalToNumber(min);
  const seconds = rationalToNumber(sec);
  if (degrees === null || minutes === null || seconds === null) return null;
  const result = degrees + minutes / 60 + seconds / 3600;
  return negative ? -result : result;
}

// Coerces a tag value to a trimmed string, or null when it is not string-like.
function toString (value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (Buffer.isBuffer(value)) return value.toString("ascii").trim() || null;
  return null;
}

// Coerces a tag value to a finite number, or null. Unwraps a single-item array.
function toNumber (value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return toNumber(value[0]);
  return null;
}

// Divides numerator by denominator. Null when the denominator is zero.
function rationalToNumber (value: Rational | null): number | null {
  if (!value) return null;
  const denominator = value.denominator;
  if (!denominator) return null;
  return value.numerator / denominator;
}

// Narrows a tag value to a Rational, or null when the shape does not match.
function toRational (value: unknown): Rational | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Rational;
  if (typeof candidate.numerator === "number" && typeof candidate.denominator === "number") {
    return candidate;
  }
  return null;
}

// Narrows a tag value to an array of Rationals, such as a GPS coordinate triplet.
function toRationalArray (value: unknown): Rational[] | null {
  if (!Array.isArray(value)) return null;
  const items = value.map(toRational).filter(Boolean) as Rational[];
  return items.length ? items : null;
}

function readUInt16 (buffer: Buffer, offset: number, little: boolean) {
  return little ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset);
}

function readUInt32 (buffer: Buffer, offset: number, little: boolean) {
  return little ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
}

function readInt32 (buffer: Buffer, offset: number, little: boolean) {
  return little ? buffer.readInt32LE(offset) : buffer.readInt32BE(offset);
}
