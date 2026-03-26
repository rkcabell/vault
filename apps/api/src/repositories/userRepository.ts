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
      select: { id: true, email: true, passwordHash: true, name: true, username: true },
    });
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

  async setResetToken (userId: string, token: string, expiry: Date) {
    return this.prisma.user.update({
      where: { id: userId },
      data: { resetToken: token, resetTokenExpiry: expiry },
    });
  }

  async findByResetToken (token: string) {
    return this.prisma.user.findFirst({
      where: { resetToken: token, resetTokenExpiry: { gt: new Date() } },
      select: { id: true, email: true },
    });
  }

  async clearResetToken (userId: string, newPasswordHash: string) {
    return this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: newPasswordHash, resetToken: null, resetTokenExpiry: null },
    });
  }
}
