// Strips noisy fields from Fastify's auto-generated request/response logs.
// Applied to the Fastify logger in index.ts and reused in createLogger().
// Parameter types are structural supertypes of FastifyRequest / ResSerializerReply
// so these functions satisfy all four Fastify() overloads without `any`.

export const reqSerializer = (req: { method?: string; url?: string }) => ({
  method: req.method,
  url: req.url,
});

export const resSerializer = (res: { statusCode: number }) => ({
  statusCode: res.statusCode,
});
