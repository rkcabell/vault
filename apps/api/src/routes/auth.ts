/**
 * Serves signing in, signing up, signing out, and renewing a session.
 */

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { passwordSchema } from "@vault/types";
import { createAuthService, AuthError } from "../services/authService.js";
import { UserRepository } from "../repositories/userRepository.js";
import { TagRuleRepository } from "../repositories/tagRuleRepository.js";
import { createPasswordHasher } from "../adapters/passwordHasher.js";
import { createJwtAdapter } from "../adapters/jwtAdapter.js";

// Checks a sign-in request has both fields, and nothing more. The password
// policy is deliberately not applied here: an account whose password was set
// before a stricter policy must still be able to sign in.
function parseCredentials(body: unknown) {
  const schema = z.object({
    email: z.string().email(),
    password: z.string().min(1),
  });
  const result = schema.safeParse(body);
  if (!result.success) {
    const field = result.error.issues[0]?.path[0];
    if (field === "email") return { error: "Invalid email address" } as const;
    return { error: "Password is required" } as const;
  }
  return { data: result.data };
}

// Checks a sign-up request, applying the full password policy to the new password.
function parseRegistration(body: unknown) {
  const schema = z.object({
    email: z.string().email(),
    password: passwordSchema,
  });
  const result = schema.safeParse(body);
  if (!result.success) {
    const issue = result.error.issues[0];
    if (issue?.path[0] === "email") return { error: "Invalid email address" } as const;
    return { error: issue?.message ?? "Invalid password" } as const;
  }
  return { data: result.data };
}

export const authRoutes: FastifyPluginAsync = async app => {
  const tagRuleRepository = new TagRuleRepository(app.prisma);
  const authService = createAuthService({
    userRepository: new UserRepository(app.prisma),
    passwordHasher: createPasswordHasher(),
    jwt: createJwtAdapter(app.jwt),
    // New accounts start with the default Tag Organizer rules.
    seedUserDefaults: userId => tagRuleRepository.seedDefaults(userId),
  });

  const cookieConfig = {
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    // Set COOKIE_SECURE only behind a real HTTPS proxy. NODE_ENV is production
    // in Docker even for a plain HTTP deployment, so it cannot decide this.
    secure: process.env.COOKIE_SECURE === "true",
  };

  // The signed-in account, read from the browser's cookie.
  app.get("/me", async (req, reply) => {
    const token = req.cookies.access_token;
    if (!token) return reply.unauthorized("Missing token");

    try {
      const { user } = await authService.getMe(token);
      return { user };
    } catch (err) {
      if (err instanceof AuthError && err.code === "INVALID_TOKEN") {
        return reply.unauthorized("Invalid or expired token");
      }
      return reply.unauthorized("Invalid or expired token");
    }
  });

  // Creates the owner's account. The tokens come back in the body rather than
  // as cookies, so signing up does not sign the browser in.
  app.post(
    "/register",
    {
      preHandler: async (req, reply) => {
        await app.rateLimit({ key: `register:ip:${req.ip}`, limit: 5, windowMs: 60_000 })(
          req,
          reply,
        );
      },
    },
    async (req, reply) => {
      if (reply.sent) return;

      // Once the owner has their account, DISABLE_REGISTRATION stops anyone
      // else on the network from creating one.
      if (app.config.DISABLE_REGISTRATION) {
        return reply.forbidden("Registration is disabled on this server.");
      }

      const parsed = parseRegistration(req.body);
      if ("error" in parsed) return reply.badRequest(parsed.error);
      const data = parsed.data;

      try {
        const { user, tokens } = await authService.register(data.email, data.password);
        req.log.info({ email: data.email }, "register");
        return { user, access: tokens.access, refresh: tokens.refresh };
      } catch (err) {
        if (err instanceof AuthError && err.code === "USER_EXISTS") {
          return reply.badRequest("User already exists");
        }
        throw err;
      }
    },
  );

  // Signs in and sets the session cookies.
  app.post(
    "/login",
    {
      preHandler: async (req, reply) => {
        await app.rateLimit({ key: `login:ip:${req.ip}`, limit: 30, windowMs: 60_000 })(req, reply);
      },
    },
    async (req, reply) => {
      if (reply.sent) return;

      const parsed = parseCredentials(req.body);
      if ("error" in parsed) return reply.badRequest(parsed.error);
      const data = parsed.data;

      // A second limit, per email address, so one account cannot be worked
      // through from many addresses.
      await app.rateLimit({ key: `login:email:${data.email}`, limit: 10, windowMs: 60_000 })(
        req,
        reply,
      );
      if (reply.sent) return;

      try {
        const { user, tokens } = await authService.login(data.email, data.password);
        req.log.info({ email: data.email }, "login");

        reply
          .clearCookie("access_token", { ...cookieConfig })
          .clearCookie("refresh_token", { ...cookieConfig })
          .setCookie("access_token", tokens.access, cookieConfig)
          .setCookie("refresh_token", tokens.refresh, cookieConfig);

        return reply.send({ user });
      } catch (err) {
        if (err instanceof AuthError && err.code === "INVALID_CREDENTIALS") {
          req.log.warn({ email: data.email }, "login failed");
          return reply.unauthorized("Invalid credentials");
        }
        throw err;
      }
    },
  );

  // Signs the browser out by dropping its cookies. The tokens themselves stay
  // valid until they expire, because nothing records which ones were issued.
  // Raising the account's token version is what actually revokes them.
  app.post("/logout", async (_req, reply) => {
    return reply
      .clearCookie("access_token", { ...cookieConfig })
      .clearCookie("refresh_token", { ...cookieConfig })
      .send({});
  });

  // There is no route for a forgotten password. Recovery is the owner running
  // scripts/reset-password.ts on the server, so no reset link is ever created
  // or sent anywhere.

  // Renews an expiring session.
  app.post(
    "/refresh",
    {
      preHandler: async (req, reply) => {
        await app.rateLimit({ key: `refresh:ip:${req.ip}`, limit: 60, windowMs: 60_000 })(
          req,
          reply,
        );
      },
    },
    async (req, reply) => {
      if (reply.sent) return;

      // Prefer the httpOnly cookie (browser clients); fall back to a body token
      // for non-browser API clients. The browser can't read httpOnly cookies,
      // so cookie-based refresh is what the web silent-renewal loop relies on.
      const body = z.object({ refresh: z.string().optional() }).safeParse(req.body);
      const refresh = req.cookies.refresh_token ?? (body.success ? body.data.refresh : undefined);
      if (!refresh) return reply.unauthorized("Missing refresh token");

      try {
        const { access, refresh: newRefresh } = await authService.refreshTokens(refresh);

        // Sliding session: replace both cookies with the freshly minted tokens.
        reply
          .clearCookie("access_token", { ...cookieConfig })
          .clearCookie("refresh_token", { ...cookieConfig })
          .setCookie("access_token", access, cookieConfig)
          .setCookie("refresh_token", newRefresh, cookieConfig);

        // Also return tokens in the body for non-browser API clients.
        return reply.send({ ok: true, access, refresh: newRefresh });
      } catch (err) {
        if (err instanceof AuthError && err.code === "INVALID_TOKEN") {
          // Evicted (or expired): drop the cookies so the client logs out
          // cleanly instead of retrying a dead refresh token in a loop.
          reply
            .clearCookie("access_token", { ...cookieConfig })
            .clearCookie("refresh_token", { ...cookieConfig });
          return reply.unauthorized("Invalid or expired refresh token");
        }
        throw err;
      }
    },
  );
};
