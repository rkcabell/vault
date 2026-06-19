import type { PrismaClient } from "@prisma/client";

export type UserProfile = {
  id: string;
  email: string;
  name: string | null;
  username: string | null;
  avatarUrl: string | null;
};

export class UserRepository {
  constructor(private readonly prisma: PrismaClient) {}

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
