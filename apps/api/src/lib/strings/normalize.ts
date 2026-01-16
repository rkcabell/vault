export function normalizeNullable (value: string | null | undefined) {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}
