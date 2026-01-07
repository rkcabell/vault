import type { FastifyPluginAsync } from "fastify";
import argon2 from "argon2";
import { z } from "zod";



export const authRoutes: FastifyPluginAsync = async (app) => {

  
  app.get("/me", async (req, reply) => {
    const token = req.cookies.access_token;
    if (!token) return reply.unauthorized("Missing token");

    try {
      const payload = app.jwt.verifyAccess(token);
      const userId = payload.sub;

      const user = await app.prisma.user.findUnique({
        where: { id: userId },
      select: { id: true, email: true },
    });

    if (!user) return reply.unauthorized("User not found");
    return { user };
  } catch {
    return reply.unauthorized("Invalid or expired token");
  }
});

  // POST /auth/register  — limit by IP (anti-signup abuse)
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

      const schema = z.object({
        email: z.string().email(),
        password: z.string().min(8),
      });
      const data = schema.parse(req.body);

      const existing = await app.prisma.user.findUnique({ where: { email: data.email } });
      if (existing) return reply.badRequest("User already exists");

      const hash = await argon2.hash(data.password);
      const user = await app.prisma.user.create({
        data: { email: data.email, passwordHash: hash },
      });

      const access = app.jwt.signAccess({ sub: user.id });
      const refresh = app.jwt.signRefresh({ sub: user.id });

      return { user: { id: user.id, email: user.email }, access, refresh };
    },
  );

  // POST /auth/login — limit by IP (pre) and by email (post-parse)
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

      const schema = z.object({
        email: z.string().email(),
        password: z.string().min(8),
      });
      
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        return reply.badRequest("Invalid email or password format");
      }
      const data = parsed.data;

      // 10 login attempts/min per email (fine-grained)
      await app.rateLimit({ key: `login:email:${data.email}`, limit: 10, windowMs: 60_000 })(
        req,
        reply,
      );
      if (reply.sent) return;

      const user = await app.prisma.user.findUnique({ where: { email: data.email } });
      if (!user) return reply.unauthorized("Invalid credentials");

      const valid = await argon2.verify(user.passwordHash, data.password);
      if (!valid) return reply.unauthorized("Invalid credentials");

      const access = app.jwt.signAccess({ sub: user.id });
      const refresh = app.jwt.signRefresh({ sub: user.id });

      reply
      .setCookie("access_token", access, {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: process.env.NODE_ENV === "production",
      })
      .setCookie("refresh_token", refresh, {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: process.env.NODE_ENV === "production",
      });

    return reply.send({ user: { id: user.id, email: user.email } });
    },
  );

  // POST /auth/refresh — modest IP limit (token reuse path)
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
        const payload = app.jwt.verifyRefresh(refresh);
        const access = app.jwt.signAccess({ sub: payload.sub });
        return { access };
      } catch {
        return reply.unauthorized("Invalid or expired refresh token");
      }
    },
  );
};
