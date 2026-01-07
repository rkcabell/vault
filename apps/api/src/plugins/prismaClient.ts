import { PrismaClient } from "@prisma/client";

// Avoid creating multiple clients in dev/hot-reload:
const g = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  g.prisma ??
  new PrismaClient({
    // optional logging to help debug
    // log: ["warn", "error"],
  });

if (process.env.NODE_ENV !== "production") {
  g.prisma = prisma;
}
