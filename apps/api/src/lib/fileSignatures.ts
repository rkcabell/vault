/**
 * Identifies a file's real format from its opening bytes, for the cases where
 * the filename extension and the recorded type cannot be trusted.
 */

/** True if `buf` opens with the PDF marker. */
export function looksLikePdf (buf: Buffer): boolean {
  return buf.length >= 4 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46;
}

/** True if `buf` opens with the PNG marker. */
export function looksLikePng (buf: Buffer): boolean {
  return (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  );
}

/**
 * True if `buf` opens with the box header an MP4 file starts with.
 *
 * HEIC files use the same header, so they pass this check too. Call
 * {@link looksLikeHeic} first where the two must be told apart.
 */
export function looksLikeMp4 (buf: Buffer): boolean {
  if (buf.length < 12) return false;
  return buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70;
}

/**
 * True if `buf` opens with the box header MP4 and HEIC share, and names one of
 * the HEIF format identifiers that follow it.
 */
export function looksLikeHeic (buf: Buffer): boolean {
  if (buf.length < 12) return false;
  const hasFtyp = buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70;
  if (!hasFtyp) return false;

  const brand = buf.subarray(8, 12).toString("ascii").toLowerCase();
  return (
    brand === "heic" ||
    brand === "heix" ||
    brand === "hevc" ||
    brand === "hevx" ||
    brand === "heim" ||
    brand === "heis" ||
    brand === "mif1" ||
    brand === "msf1"
  );
}
