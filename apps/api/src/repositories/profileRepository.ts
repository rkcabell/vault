import type { PrismaClient } from "@prisma/client";

const profileSelect = {
  id: true,
  email: true,
  name: true,
  username: true,
  bio: true,
  website: true,
  location: true,
  avatarUrl: true,
  createdAt: true,
} as const;

export class ProfileRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async getProfile (userId: string) {
    return this.prisma.user.findUnique({
      where: { id: userId },
      select: profileSelect,
    });
  }

  async updateProfile (
    userId: string,
    data: {
      name?: string | null;
      username?: string | null;
      bio?: string | null;
      website?: string | null;
      location?: string | null;
      avatarUrl?: string | null;
    },
  ) {
    return this.prisma.user.update({
      where: { id: userId },
      data,
      select: profileSelect,
    });
  }
}
