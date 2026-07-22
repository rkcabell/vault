/**
 * Minimal single-range parser for `Range: bytes=...` request headers, backing
 * HTTP 206 responses on the storage proxy and in-place source routes (video
 * seeking and large-file partial reads depend on it).
 *
 * Only the first range of a multi-range header is honored — browsers request
 * one range per media fetch, and multipart/byteranges responses aren't worth
 * their complexity here.
 */

export type ByteRange = { start: number; end: number };

/**
 * Parse a Range header against a known object size.
 *
 * Returns:
 *   - `null` — no header / not a bytes range / malformed → serve the full body (200)
 *   - `ByteRange` — a satisfiable, clamped inclusive range → serve 206
 *   - `"unsatisfiable"` — syntactically valid but outside the object → serve 416
 */
export function parseRangeHeader (header: string | undefined, size: number): ByteRange | "unsatisfiable" | null {
  if (!header || size <= 0) return header && size === 0 ? "unsatisfiable" : null;
  const match = /^bytes=(\d*)-(\d*)(?:,|$)/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return null;

  if (rawStart === "") {
    // Suffix form `bytes=-N`: the final N bytes.
    const suffix = Number(rawEnd);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return "unsatisfiable";
    const start = Math.max(0, size - suffix);
    return { start, end: size - 1 };
  }

  const start = Number(rawStart);
  const end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
  if (start >= size || end < start) return "unsatisfiable";
  return { start, end };
}
