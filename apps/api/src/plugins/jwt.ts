// apps/api/src/plugins/jwt.ts
import fp from "fastify-plugin";
import jwt from "jsonwebtoken";
import type { FastifyPluginAsync } from "fastify";
import type { JwtPayload, SignOptions } from "jsonwebtoken";

// Tokens always include `sub`; `tv` (tokenVersion) is present on tokens minted
// after the session-eviction change and absent on older ones.
type AccessClaims = JwtPayload & { sub: string; tv?: number };
type RefreshClaims = JwtPayload & { sub: string; tv?: number };

declare module "fastify" {
  interface FastifyInstance {
    jwt: {
      signAccess(payload: Record<string, unknown>): string;
      signRefresh(payload: Record<string, unknown>): string;
      verifyAccess(token: string): AccessClaims;
      verifyRefresh(token: string): RefreshClaims;
    };
  }
}

const jwtPlugin: FastifyPluginAsync = async (app) => {
  // Idempotent in dev/hot-reload
  if (app.hasDecorator("jwt")) return;

  const accessSecret = app.config.JWT_SECRET;
  const refreshSecret = app.config.JWT_REFRESH_SECRET;
  const accessTtl = app.config.JWT_ACCESS_TTL as SignOptions["expiresIn"];
  const refreshTtl = app.config.JWT_REFRESH_TTL as SignOptions["expiresIn"];

  function assertSub(payload: JwtPayload): asserts payload is AccessClaims {
    if (!payload || typeof payload.sub !== "string") {
      throw new Error("JWT is missing required 'sub' claim");
    }
  }

  app.decorate("jwt", {
    signAccess(payload: Record<string, unknown>) {
      return jwt.sign(payload, accessSecret, { expiresIn: accessTtl });
    },
    signRefresh(payload: Record<string, unknown>) {
      return jwt.sign(payload, refreshSecret, { expiresIn: refreshTtl });
    },
    verifyAccess(token: string): AccessClaims {
      const payload = jwt.verify(token, accessSecret) as JwtPayload;
      assertSub(payload);
      return payload;
    },
    verifyRefresh(token: string): RefreshClaims {
      const payload = jwt.verify(token, refreshSecret) as JwtPayload;
      assertSub(payload);
      return payload;
    },
  });
};

export default fp(jwtPlugin, { name: "jwt" });
