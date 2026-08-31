/**
 * Signing up, signing in, and renewing a session.
 */
import { createJwtAdapter, type JwtAdapter } from "../adapters/jwtAdapter.js";
import { createPasswordHasher, type PasswordHasher } from "../adapters/passwordHasher.js";
import { type UserRepository } from "../repositories/userRepository.js";

export type AuthTokens = { access: string; refresh: string };
export type AuthUser = { id: string; email: string; name?: string | null; username?: string | null };

/** Signals that a sign-up, sign-in or token check was refused, and why. */
export class AuthError extends Error {
  constructor(public code: "USER_EXISTS" | "INVALID_CREDENTIALS" | "INVALID_TOKEN") {
    super(code);
  }
}

export type AuthServiceDeps = {
  userRepository: UserRepository;
  passwordHasher?: PasswordHasher;
  jwt?: JwtAdapter;
  /**
   * Sets up whatever a new account starts with, such as its tagging rules.
   *
   * A failure here is ignored: an account missing its starting rules is a far
   * smaller problem than a sign-up that does not complete.
   */
  seedUserDefaults?: (userId: string) => Promise<void>;
};

/**
 * Builds the authentication service.
 *
 * Password hashing and token signing may be replaced through `deps`. The stand-
 * in used when they are not supplied raises on every call, so a caller that
 * forgets one finds out immediately rather than issuing unsigned tokens.
 */
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

  // Creates an account and signs its first pair of tokens.
  // Raises USER_EXISTS if the email address is already taken.
  const register = async (email: string, password: string) => {
    const existing = await deps.userRepository.findByEmail(email);
    if (existing) throw new AuthError("USER_EXISTS");

    const hash = await passwordHasher.hash(password);
    const user = await deps.userRepository.createUser({ email, passwordHash: hash });

    await deps.seedUserDefaults?.(user.id).catch(() => {});

    // A new account has token version 0, matching the column default.
    const tokens: AuthTokens = {
      access: jwt.signAccess({ sub: user.id, tv: 0 }),
      refresh: jwt.signRefresh({ sub: user.id, tv: 0 }),
    };

    return { user, tokens };
  };

  // Checks a password and signs a pair of tokens for the account.
  // Raises INVALID_CREDENTIALS whether the email or the password was wrong, so
  // the response cannot be used to discover which addresses have accounts.
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

  // Exchanges a refresh token for a new pair. Raises INVALID_TOKEN when the
  // token is unreadable, its account is gone, or it has been revoked.
  const refreshTokens = async (refresh: string) => {
    let payload: { sub: string; tv?: number };
    try {
      payload = jwt.verifyRefresh(refresh);
    } catch {
      throw new AuthError("INVALID_TOKEN");
    }

    // Where revocation takes effect. A refresh token works only while its token
    // version still matches the account's. Resetting a password raises the
    // account's version, and every token signed before then stops working.
    const current = await deps.userRepository.getTokenVersion(payload.sub);
    if (current === null) throw new AuthError("INVALID_TOKEN");
    if ((payload.tv ?? 0) !== current) throw new AuthError("INVALID_TOKEN");

    // Both tokens are replaced, so a session in continuous use never expires.
    // Revocation still runs through the token version rather than any record of
    // which tokens were issued.
    const access = jwt.signAccess({ sub: payload.sub, tv: current });
    const newRefresh = jwt.signRefresh({ sub: payload.sub, tv: current });
    return { access, refresh: newRefresh };
  };

  // Returns the account a valid access token belongs to.
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
