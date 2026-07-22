import { createJwtAdapter, type JwtAdapter } from "../adapters/jwtAdapter.js";
import { createPasswordHasher, type PasswordHasher } from "../adapters/passwordHasher.js";
import { type UserRepository } from "../repositories/userRepository.js";

export type AuthTokens = { access: string; refresh: string };
export type AuthUser = { id: string; email: string; name?: string | null; username?: string | null };

export class AuthError extends Error {
  constructor(public code: "USER_EXISTS" | "INVALID_CREDENTIALS" | "INVALID_TOKEN") {
    super(code);
  }
}

export type AuthServiceDeps = {
  userRepository: UserRepository;
  passwordHasher?: PasswordHasher;
  jwt?: JwtAdapter;
  /** Seeds per-user defaults (e.g. the built-in tag rules) after registration.
   *  Failures are swallowed — a missing default set must not fail signup. */
  seedUserDefaults?: (userId: string) => Promise<void>;
};

export function createAuthService (deps: AuthServiceDeps) {
  const passwordHasher = deps.passwordHasher ?? createPasswordHasher();
  const jwt = deps.jwt ?? createJwtAdapter({
    signAccess: () => {
      throw new Error("signAccess not provided");
    },
    signRefresh: () => {
      throw new Error("signRefresh not provided");
    },
    verifyAccess: () => {
      throw new Error("verifyAccess not provided");
    },
    verifyRefresh: () => {
      throw new Error("verifyRefresh not provided");
    },
  });

  const register = async (email: string, password: string) => {
    const existing = await deps.userRepository.findByEmail(email);
    if (existing) throw new AuthError("USER_EXISTS");

    const hash = await passwordHasher.hash(password);
    const user = await deps.userRepository.createUser({ email, passwordHash: hash });

    await deps.seedUserDefaults?.(user.id).catch(() => {});

    // New account: tokenVersion starts at 0 (the column default).
    const tokens: AuthTokens = {
      access: jwt.signAccess({ sub: user.id, tv: 0 }),
      refresh: jwt.signRefresh({ sub: user.id, tv: 0 }),
    };

    return { user, tokens };
  };

  const login = async (email: string, password: string) => {
    const user = await deps.userRepository.findByEmail(email);
    if (!user) throw new AuthError("INVALID_CREDENTIALS");

    const ok = await passwordHasher.verify(user.passwordHash, password);
    if (!ok) throw new AuthError("INVALID_CREDENTIALS");

    const tv = user.tokenVersion ?? 0;
    const tokens: AuthTokens = {
      access: jwt.signAccess({ sub: user.id, tv }),
      refresh: jwt.signRefresh({ sub: user.id, tv }),
    };

    return { user: { id: user.id, email: user.email }, tokens };
  };

  const refreshTokens = async (refresh: string) => {
    let payload: { sub: string; tv?: number };
    try {
      payload = jwt.verifyRefresh(refresh);
    } catch {
      throw new AuthError("INVALID_TOKEN");
    }

    // Eviction point: a refresh token only mints a new access token if its
    // tokenVersion still matches the user's current one. A password reset bumps
    // tokenVersion, so tokens issued before the reset stop refreshing.
    const current = await deps.userRepository.getTokenVersion(payload.sub);
    if (current === null) throw new AuthError("INVALID_TOKEN");
    if ((payload.tv ?? 0) !== current) throw new AuthError("INVALID_TOKEN");

    // Sliding session: re-issue both tokens so an actively-used session never
    // expires. The new refresh carries a fresh TTL; eviction still rides on
    // tokenVersion (a reset bumps it, so every prior refresh stops minting).
    const access = jwt.signAccess({ sub: payload.sub, tv: current });
    const newRefresh = jwt.signRefresh({ sub: payload.sub, tv: current });
    return { access, refresh: newRefresh };
  };

  const getMe = async (token: string) => {
    try {
      const payload = jwt.verifyAccess(token);
      const user = await deps.userRepository.findById(payload.sub);
      if (!user) throw new AuthError("INVALID_TOKEN");
      return { user };
    } catch {
      throw new AuthError("INVALID_TOKEN");
    }
  };

  return {
    register,
    login,
    refreshTokens,
    getMe,
  };
}
