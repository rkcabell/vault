/**
 * Minimal EXIF parser operating directly on a raw buffer (no external deps).
 *
 * Supports the TIFF-encoded EXIF header embedded in JPEG APP1 segments.
 * Handles both little-endian (Intel, "II") and big-endian (Motorola, "MM")
 * byte orders, and reads IFD0, the Exif sub-IFD (0x8769), and the GPS
 * sub-IFD (0x8825).
 *
 * Only the TIFF types actually used by common EXIF tags are decoded (ASCII,
 * SHORT, LONG, RATIONAL, UNDEFINED, SLONG, SRATIONAL). Unknown types and
 * out-of-bounds reads return null rather than throwing.
 */
import type { ImageGps } from "../types.js";

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
 * Parse an EXIF buffer (starting with the "Exif\0\0" header) and return the
 * camera/lens/GPS fields used by the app. Returns null if the header is
 * missing, malformed, or too short to contain a valid IFD0.
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
 * Read a TIFF Image File Directory (IFD) starting at `offset`.
 * Each 12-byte entry holds: tag (2), type (2), count (4), value/offset (4).
 * `tiffStart` anchors all value offsets that point outside the 4-byte inline
 * value field (i.e. when byteLength > 4).
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
 * Decode the value for a single IFD entry according to its TIFF type id.
 *
 * If the total byte length of the value is ≤ 4, the value is stored inline
 * starting at entryOffset + 8 (the value/offset field of the IFD entry).
 * Otherwise it is stored at tiffStart + valueOffset.
 *
 * Returns null for unknown types, out-of-bounds accesses, or a count of zero.
 * Scalar values (count == 1) are unwrapped from their array; multi-component
 * values are returned as arrays.
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
    // Type 5 — RATIONAL: two unsigned 32-bit integers (numerator / denominator).
    // Each component is 8 bytes. Used for exposure time, f-number, focal length, GPS coords, etc.
    case 5: {
      const values: Rational[] = [];
      for (let i = 0; i < count; i += 1) {
        const numerator = readUInt32(buffer, valueStart + i * 8, little);
        const denominator = readUInt32(buffer, valueStart + i * 8 + 4, little);
        values.push({ numerator, denominator });
      }
      return count === 1 ? values[0] : values;
    }
    // Type 7 — UNDEFINED: raw bytes with application-defined meaning.
    // Returned as a Buffer slice; callers interpret the bytes themselves.
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
    // Type 10 — SRATIONAL: two signed 32-bit integers (numerator / denominator).
    // Same layout as RATIONAL but uses int32 arithmetic; used for signed GPS altitude offsets, etc.
    case 10: {
      const values: Rational[] = [];
      for (let i = 0; i < count; i += 1) {
        const numerator = readInt32(buffer, valueStart + i * 8, little);
        const denominator = readInt32(buffer, valueStart + i * 8 + 4, little);
        values.push({ numerator, denominator });
      }
      return count === 1 ? values[0] : values;
    }
    // Types 1 (BYTE), 6 (SBYTE), 8 (SSHORT), and any vendor extension are not
    // needed by the tags we extract, so they fall through to null.
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
 * Convert raw GPS IFD tags into decimal-degree latitude/longitude/altitude.
 * Returns null if the mandatory ref or coordinate tags are absent or invalid.
 * Altitude is negated when GPSAltitudeRef (0x0005) equals 1 (below sea level).
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
 * Convert a [degrees, minutes, seconds] RATIONAL triplet to a decimal degree
 * value. Pass `negative = true` for S latitude or W longitude.
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

/** Coerce an EXIF tag value to a trimmed string, or null if not string-like. */
function toString (value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (Buffer.isBuffer(value)) return value.toString("ascii").trim() || null;
  return null;
}

/** Coerce an EXIF tag value to a finite number, or null. Unwraps single-item arrays. */
function toNumber (value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return toNumber(value[0]);
  return null;
}

/** Divide numerator by denominator, returning null if denominator is zero or value is null. */
function rationalToNumber (value: Rational | null): number | null {
  if (!value) return null;
  const denominator = value.denominator;
  if (!denominator) return null;
  return value.numerator / denominator;
}

/** Narrow an unknown tag value to a Rational object, or null if the shape doesn't match. */
function toRational (value: unknown): Rational | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Rational;
  if (typeof candidate.numerator === "number" && typeof candidate.denominator === "number") {
    return candidate;
  }
  return null;
}

/** Narrow an unknown tag value to an array of Rational objects (e.g. GPS coordinate triplets). */
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
