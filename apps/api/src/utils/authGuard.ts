import type { FastifyReply, FastifyRequest } from "fastify";

declare module "fastify" {
  interface FastifyRequest {
    userId?: string;
  }
}

export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  const hdr = req.headers.authorization ?? "";
  const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : null;
  if (!token) return reply.unauthorized();

  try {
    const payload = req.server.jwt.verifyAccess(token) as { sub: string };
    req.userId = payload.sub;
  } catch {
    return reply.unauthorized();
  }
}
