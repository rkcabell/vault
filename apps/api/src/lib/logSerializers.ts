/**
 * Cuts Fastify's automatic request and response log entries down to the few
 * fields worth keeping.
 */

/**
 * Reduces a logged request to its method and URL.
 *
 * The parameter type is deliberately looser than FastifyRequest so this
 * function satisfies every Fastify logger overload without `any`.
 */
export const reqSerializer = (req: { method?: string; url?: string }) => ({
  method: req.method,
  url: req.url,
});

/** Reduces a logged response to its status code. See {@link reqSerializer} on the parameter type. */
export const resSerializer = (res: { statusCode: number }) => ({
  statusCode: res.statusCode,
});
