/**
 * Reads the byte range a client asked for out of a `Range` request header.
 *
 * Only the first range in the header is honored. A request for several ranges
 * at once is answered with the first one alone.
 */

export type ByteRange = { start: number; end: number };

/**
 * Returns the byte range to send for `header`, given an object of `size` bytes.
 *
 * Three outcomes, and the caller must handle each differently:
 *   - `null` — no range was asked for, or the header made no sense; send the whole body with 200.
 *   - a range — the start and end are both inclusive, and already clamped to the object; send 206.
 *   - `"unsatisfiable"` — a well-formed range that falls outside the object; send 416.
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
