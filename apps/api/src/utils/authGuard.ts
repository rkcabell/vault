/**
 * Rejects a request that is not signed in, and records who made it.
 */
import type { FastifyReply, FastifyRequest } from "fastify";

declare module "fastify" {
  interface FastifyRequest {
    userId?: string;
  }
}

// Reads one cookie, falling back to parsing the header directly when the cookie
// plugin has not filled in `req.cookies`.
function readCookie (req: FastifyRequest, name: string): string | null {
  const cookies = req.cookies;
  if (cookies && typeof cookies[name] === "string") {
    return cookies[name];
  }

  const raw = req.headers.cookie ?? "";
  if (!raw) return null;

  const parts = raw.split(";").map(p => p.trim());
  for (const p of parts) {
    const idx = p.indexOf("=");
    if (idx === -1) continue;
    const k = p.slice(0, idx).trim();
    if (k !== name) continue;

    const v = p.slice(idx + 1);
    try {
      return decodeURIComponent(v);
    } catch {
      return v;
    }
  }

  return null;
}

// True if `value` is a decoded token carrying an account id.
function isJwtPayload (value: unknown): value is { sub: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "sub" in value &&
    typeof (value as { sub?: unknown }).sub === "string"
  );
}

/**
 * Rejects the request with 401 unless it carries a valid access token.
 *
 * A request that passes has `req.userId` set to the signed-in account, which is
 * what every route reads to scope its work. An `Authorization` header is
 * preferred over the cookie, so a client with no cookie store can still be
 * recognized.
 */
export async function requireAuth (req: FastifyRequest, reply: FastifyReply) {
  const hdr = req.headers.authorization ?? "";

  let token: string | null = hdr.startsWith("Bearer ") ? hdr.slice(7) : null;

  if (!token) token = readCookie(req, "access_token");

  if (!token) return reply.unauthorized();

  try {
    const payload: unknown = req.server.jwt.verifyAccess(token);
    if (!isJwtPayload(payload)) return reply.unauthorized();
    req.userId = payload.sub;
  } catch {
    return reply.unauthorized();
  }
}
