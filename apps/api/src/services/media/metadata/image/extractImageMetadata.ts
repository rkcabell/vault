import sharp from "sharp";
import type { ImageMetadata } from "../types.js";
import { parseExif } from "./exif.js";

/**
 * Reads an image's dimensions and camera fields, combining what sharp reports
 * about the pixels with the EXIF block when the file carries one.
 */

/**
 * Returns an image's camera and dimension fields, or null when the buffer
 * cannot be read as an image.
 */
export async function extractImageMetadata (buffer: Buffer): Promise<ImageMetadata | null> {
  try {
    const info = await sharp(buffer, { failOn: "none" }).metadata();
    const exif = info.exif ? parseExif(info.exif) : null;

    const width = info.width ?? null;
    const height = info.height ?? null;
    const exifColorSpace = normalizeColorSpace(exif?.colorSpace ?? null);

    return {
      make: exif?.make ?? null,
      model: exif?.model ?? null,
      lens: exif?.lens ?? null,
      iso: exif?.iso ?? null,
      exposureTime: exif?.exposureTime ?? null,
      fNumber: exif?.fNumber ?? null,
      focalLengthMm: exif?.focalLengthMm ?? null,
      orientation: exif?.orientation ?? info.orientation ?? null,
      colorSpace: exifColorSpace ?? normalizeColorSpace(info.space),
      editedBy: exif?.editedBy ?? null,
      capturedAt: exif?.capturedAt ?? null,
      width,
      height,
      bitDepth: mapBitDepth(info.depth),
      hasAlpha: typeof info.hasAlpha === "boolean" ? info.hasAlpha : null,
      gps: exif?.gps ?? null,
    };
  } catch {
    return null;
  }
}

// A number here is the EXIF ColorSpace tag. Any other name is passed through.
function normalizeColorSpace (space?: string | number | null): string | null {
  if (space === null || space === undefined) return null;
  if (typeof space === "number") {
    if (space === 1) return "sRGB";
    if (space === 2) return "Adobe RGB";
    if (space === 65535) return "Uncalibrated";
    return String(space);
  }
  const normalized = space.trim();
  if (!normalized) return null;
  if (normalized.toLowerCase() === "srgb") return "sRGB";
  return normalized.toUpperCase();
}

// sharp reports bit depth as the name of a C type.
function mapBitDepth (depth?: string | null): number | null {
  if (!depth) return null;
  switch (depth) {
    case "char":
    case "uchar":
      return 8;
    case "short":
    case "ushort":
      return 16;
    case "int":
    case "uint":
    case "float":
      return 32;
    case "double":
      return 64;
    default:
      return null;
  }
}
