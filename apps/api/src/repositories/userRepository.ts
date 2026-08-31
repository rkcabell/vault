/**
 * Reads and writes user accounts for signing in and signing up.
 */
import type { PrismaClient } from "@prisma/client";

export type UserProfile = {
  id: string;
  email: string;
  name: string | null;
  username: string | null;
  avatarUrl: string | null;
};

/** Reads and writes the account records behind authentication. */
export class UserRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /** Returns the account for `email`, including its password hash. Only sign-in should need the hash. */
  async findByEmail (email: string) {
    return this.prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true, passwordHash: true, name: true, username: true, tokenVersion: true },
    });
  }

  /** Current tokenVersion for a user, or null if the user no longer exists. */
  async getTokenVersion (id: string): Promise<number | null> {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: { tokenVersion: true },
    });
    return user ? user.tokenVersion : null;
  }

  /** Returns the account for `id` without its password hash, for handing to a caller. */
  async findById (id: string) {
    return this.prisma.user.findUnique({
      where: { id },
      select: { id: true, email: true, name: true, username: true, avatarUrl: true },
    });
  }

  async createUser (data: { email: string; passwordHash: string }) {
    return this.prisma.user.create({
      data,
      select: { id: true, email: true },
    });
  }
}
