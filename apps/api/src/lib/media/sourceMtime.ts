/**
 * Compares recorded file-modified times to tell whether a file changed. Cheaper
 * than hashing the contents of every file on disk.
 */

/** Widest gap still counted as unchanged. The stored column resolves to about a
 *  millisecond once Prisma has written it; 25 ms leaves room above that. */
export const MTIME_TOLERANCE_MS = 25;

/**
 * True when `a` and `b` are close enough to count as the same modified time.
 * Null on either side is unknown, and never matches. A stored time is never
 * bit-exact, so the comparison allows `MTIME_TOLERANCE_MS` of drift.
 */
export function sameMtime (a: number | null, b: number | null): boolean {
  if (a === null || b === null) return false;
  return Math.abs(a - b) < MTIME_TOLERANCE_MS;
}
