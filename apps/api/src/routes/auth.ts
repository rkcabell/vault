//File: apps/api/src/routes/auth.ts

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { createAuthService, AuthError } from "../services/authService.js";
import { UserRepository } from "../repositories/userRepository.js";
import { createPasswordHasher } from "../adapters/passwordHasher.js";
import { createJwtAdapter } from "../adapters/jwtAdapter.js";

function parseAuthBody(body: unknown) {
  const schema = z.object({
    email: z.string().email(),
    password: z.string().min(8),
  });
  const result = schema.safeParse(body);
  if (!result.success) {
    const field = result.error.issues[0]?.path[0];
    if (field === "email") return { error: "Invalid email address" } as const;
    return { error: "Password must be at least 8 characters" } as const;
  }
  return { data: result.data };
}

export const authRoutes: FastifyPluginAsync = async app => {
  const authService = createAuthService({
    userRepository: new UserRepository(app.prisma),
    passwordHasher: createPasswordHasher(),
    jwt: createJwtAdapter(app.jwt),
  });

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

      const parsed = parseAuthBody(req.body);
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

      const parsed = parseAuthBody(req.body);
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
        const cookieConfig = {
          httpOnly: true,
          sameSite: "lax" as const,
          path: "/",
          secure: process.env.NODE_ENV === "production",
        };

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

      const schema = z.object({ refresh: z.string() });
      const { refresh } = schema.parse(req.body);

      try {
        const { access } = await authService.refreshTokens(refresh);
        return { access };
      } catch (err) {
        if (err instanceof AuthError && err.code === "INVALID_TOKEN") {
          return reply.unauthorized("Invalid or expired refresh token");
        }
        throw err;
      }
    },
  );
};
