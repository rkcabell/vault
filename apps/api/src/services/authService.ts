import { createJwtAdapter, type JwtAdapter } from "../adapters/jwtAdapter.js";
import { createPasswordHasher, type PasswordHasher } from "../adapters/passwordHasher.js";
import { UserRepository } from "../repositories/userRepository.js";

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

    const tokens: AuthTokens = {
      access: jwt.signAccess({ sub: user.id }),
      refresh: jwt.signRefresh({ sub: user.id }),
    };

    return { user, tokens };
  };

  const login = async (email: string, password: string) => {
    const user = await deps.userRepository.findByEmail(email);
    if (!user) throw new AuthError("INVALID_CREDENTIALS");

    const ok = await passwordHasher.verify(user.passwordHash, password);
    if (!ok) throw new AuthError("INVALID_CREDENTIALS");

    const tokens: AuthTokens = {
      access: jwt.signAccess({ sub: user.id }),
      refresh: jwt.signRefresh({ sub: user.id }),
    };

    return { user: { id: user.id, email: user.email }, tokens };
  };

  const refreshTokens = async (refresh: string) => {
    try {
      const payload = jwt.verifyRefresh(refresh);
      const access = jwt.signAccess({ sub: payload.sub });
      return { access };
    } catch {
      throw new AuthError("INVALID_TOKEN");
    }
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
