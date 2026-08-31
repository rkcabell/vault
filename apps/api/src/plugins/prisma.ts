/**
 * Puts the shared database client on the Fastify instance and closes it when
 * the server shuts down.
 */
import fp from "fastify-plugin";
import { prisma, type PrismaClient } from "@vault/db";

declare module "fastify" {
  interface FastifyInstance {
    prisma: PrismaClient;
  }
}

export default fp(
  async (app) => {
    if (app.hasDecorator("prisma")) return;

    // The client is a singleton created in @vault/db, so this only attaches it
    // and arranges for it to be closed.

    app.addHook("onClose", async () => {
      await prisma.$disconnect();
    });
    
    app.decorate("prisma", prisma);
  },
  { name: "prisma" },
);
