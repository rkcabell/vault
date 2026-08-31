/**
 * Trimming helper for text fields that a caller may leave blank.
 */

/** Returns `value` trimmed, or null. A string of only whitespace becomes null, not an empty string. */
export function normalizeNullable (value: string | null | undefined) {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}
