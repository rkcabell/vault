/**
 * Reads DEDUP_STRICT_ORDER, which is off by default. On, a renderable row is
 * hashed before its thumbnail or text claim can fire, so two copies indexed in
 * the same window both find a finished twin instead of each rendering its own.
 */

export function isDedupStrictOrder (): boolean {
  return process.env.DEDUP_STRICT_ORDER === "true";
}
