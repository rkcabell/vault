import fp from "fastify-plugin";
import { checkOrigin, isStateChanging } from "../lib/http/originCheck.js";

/**
 * Rejects state-changing requests from origins outside the allow-list. It is
 * applied to every route at once, so a route added later is covered without
 * opting in. {@link checkOrigin} holds the rule for a request that sends no
 * origin header.
 */

export default fp(
  async app => {
    const allowed = app.config.csrfAllowedOrigins;

    if (allowed === null) {
      app.log.warn(
        "CSRF origin check is OFF (ALLOWED_ORIGINS=*): any site a logged-in browser " +
          "visits can make authenticated writes to this server",
      );
      return;
    }

    app.log.info({ allowed }, "CSRF origin allow-list");

    // onRequest runs before body parsing, so a forged 2 GB PUT is refused
    // rather than read to disk first.
    app.addHook("onRequest", async (req, reply) => {
      if (!isStateChanging(req.method)) return;

      const verdict = checkOrigin(req.headers, allowed);
      if (verdict.ok) return;

      req.log.warn(
        { method: req.method, url: req.url, header: verdict.header, value: verdict.value },
        "csrf: rejected cross-origin request",
      );
      await reply.code(403).send({
        statusCode: 403,
        error: "Forbidden",
        message: `Request origin ${verdict.value} is not allowed. Set ALLOWED_ORIGINS to the origin you reach Vault on.`,
      });
      return reply; // returning reply stops the chain; sending alone does not
    });
  },
  { name: "csrf" },
);
