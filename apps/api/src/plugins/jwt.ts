/**
 * Signs and verifies the access and refresh tokens that keep a browser signed
 * in, and puts them on the Fastify instance.
 */
import fp from "fastify-plugin";
import jwt from "jsonwebtoken";
import type { FastifyPluginAsync } from "fastify";
import type { JwtPayload, SignOptions } from "jsonwebtoken";

// `tv` is optional because tokens signed before token versioning existed carry
// none. See {@link JwtAdapter} for what the claim means.
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
  // Re-registering during a hot reload must not throw.
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
