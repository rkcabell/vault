import type { FastifyReply, FastifyRequest } from "fastify";

declare module "fastify" {
  interface FastifyRequest {
    userId?: string;
  }
}

function readCookie (req: FastifyRequest, name: string): string | null {
  // If fastify-cookie is registered, req.cookies may exist
  const anyReq = req as any;
  if (anyReq.cookies && typeof anyReq.cookies[name] === "string") {
    return anyReq.cookies[name] as string;
  }

  // Fallback: parse cookie header manually
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

export async function requireAuth (req: FastifyRequest, reply: FastifyReply) {
  const hdr = req.headers.authorization ?? "";

  // Prefer Bearer token if present
  let token: string | null = hdr.startsWith("Bearer ") ? hdr.slice(7) : null;

  // Otherwise fall back to cookie auth
  if (!token) token = readCookie(req, "access_token");

  if (!token) return reply.unauthorized();

  try {
    const payload = req.server.jwt.verifyAccess(token) as { sub: string };
    (req as any).userId = payload.sub;
  } catch {
    return reply.unauthorized();
  }
}
