/**
 * Decides whether a state-changing request came from an origin this server
 * allows. Cookie auth means the browser attaches `access_token` to every request
 * aimed at Vault, including one a hostile page made on the user's behalf, and
 * nothing else in the request tells the two apart. `SameSite=Lax` on the cookie
 * is the first defence; this one also covers a same-site subdomain, and a
 * browser too old to honour Lax.
 */

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** True for a method that may change state. Browsers omit `Origin` on the safe
 *  methods, so checking those would reject every page load. */
export function isStateChanging (method: string): boolean {
  return !SAFE_METHODS.has(method.toUpperCase());
}

/**
 * Returns `scheme://host[:port]`, lowercased and with a default port dropped.
 * Null when the value is not a parseable absolute URL. That includes the literal
 * "null" a sandboxed iframe sends, so an opaque origin never matches an entry.
 */
export function normalizeOrigin (value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin.toLowerCase();
  } catch {
    return null;
  }
}

/** Returns the allowed origins, or null for `*`, which turns the check off. */
export function parseAllowedOrigins (raw: string | null | undefined): string[] | null {
  if (raw?.trim() === "*") return null;
  const out: string[] = [];
  for (const part of (raw ?? "").split(",")) {
    const origin = normalizeOrigin(part.trim());
    if (origin && !out.includes(origin)) out.push(origin);
  }
  return out;
}

export type OriginVerdict =
  | { ok: true }
  | { ok: false; header: "origin" | "referer"; value: string };

/**
 * Returns whether a request's origin is one of `allowed`. A request carrying
 * neither `Origin` nor `Referer` passes: browsers send `Origin` on every
 * non-safe request and forbid page script from touching it, so a request with
 * neither is not a browser, and holds no ambient cookie to forge with.
 */
export function checkOrigin (
  headers: { origin?: string | undefined; referer?: string | undefined },
  allowed: string[],
): OriginVerdict {
  if (headers.origin !== undefined) {
    const origin = normalizeOrigin(headers.origin);
    if (origin !== null && allowed.includes(origin)) return { ok: true };
    return { ok: false, header: "origin", value: headers.origin };
  }

  if (headers.referer !== undefined) {
    const referer = normalizeOrigin(headers.referer);
    if (referer !== null && allowed.includes(referer)) return { ok: true };
    return { ok: false, header: "referer", value: headers.referer };
  }

  return { ok: true };
}
