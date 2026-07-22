//File: apps/api/src/routes/auth.ts

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { passwordSchema } from "@vault/types";
import { createAuthService, AuthError } from "../services/authService.js";
import { UserRepository } from "../repositories/userRepository.js";
import { TagRuleRepository } from "../repositories/tagRuleRepository.js";
import { createPasswordHasher } from "../adapters/passwordHasher.js";
import { createJwtAdapter } from "../adapters/jwtAdapter.js";

// Login: validate shape only. Never enforce the password *policy* here, or we
// would lock out users whose password predates a later policy change — login
// just needs a present credential to check against the stored hash.
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

// Registration: enforce the full shared password policy on the new password.
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
    // Use COOKIE_SECURE=true only when behind a real HTTPS reverse proxy.
    // NODE_ENV=production is set in Docker even for plain HTTP local deployments,
    // so we gate on an explicit env var instead.
    secure: process.env.COOKIE_SECURE === "true",
  };

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

  // POST /auth/register
  app.post(
    "/register",
    {
      preHandler: async (req, reply) => {
        // 5 registrations/min per IP
        await app.rateLimit({ key: `register:ip:${req.ip}`, limit: 5, windowMs: 60_000 })(
          req,
          reply,
        );
      },
    },
    async (req, reply) => {
      if (reply.sent) return;

      // Self-hosted lock: once the owner has created their account, set
      // DISABLE_REGISTRATION=true so nobody else on the network can register.
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

  // POST /auth/login
  app.post(
    "/login",
    {
      preHandler: async (req, reply) => {
        // 30 login attempts/min per IP
        await app.rateLimit({ key: `login:ip:${req.ip}`, limit: 30, windowMs: 60_000 })(req, reply);
      },
    },
    async (req, reply) => {
      if (reply.sent) return;

      const parsed = parseCredentials(req.body);
      if ("error" in parsed) return reply.badRequest(parsed.error);
      const data = parsed.data;

      // 10 login attempts/min per email (fine-grained)
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

  // POST /auth/logout — clears the auth cookies. Stateless JWTs can't be
  // revoked server-side, so this just drops the browser's session; the tokens
  // themselves remain valid until they expire (or are evicted via tokenVersion).
  app.post("/logout", async (_req, reply) => {
    return reply
      .clearCookie("access_token", { ...cookieConfig })
      .clearCookie("refresh_token", { ...cookieConfig })
      .send({});
  });

  // Password recovery is admin-only via the reset-password CLI
  // (apps/api/scripts/reset-password.ts) — there is no self-service reset
  // endpoint, so no reset token is ever generated or put in transit.

  // POST /auth/refresh
  app.post(
    "/refresh",
    {
      preHandler: async (req, reply) => {
        // 60 refreshes/min per IP
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
