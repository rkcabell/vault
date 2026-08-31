/**
 * Hashes and checks account passwords with Argon2, behind an interface so
 * services can be tested without running the real hash.
 */
import argon2 from "argon2";

export interface PasswordHasher {
  hash: (plain: string) => Promise<string>;
  verify: (hash: string, plain: string) => Promise<boolean>;
}

export function createPasswordHasher (): PasswordHasher {
  return {
    hash: async (plain: string) => argon2.hash(plain),
    verify: async (hash: string, plain: string) => argon2.verify(hash, plain),
  };
}
