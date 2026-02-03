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
    
    // The client is already instantiated and cached in @vault/db
    // We just need to handle connection/disconnection lifecycle if desired, 
    // though typically the singleton manages itself in serverless/long-running.
    // For fastify, we can ensure we disconnect on close.
    
    app.addHook("onClose", async () => {
      await prisma.$disconnect();
    });
    
    app.decorate("prisma", prisma);
  },
  { name: "prisma" },
);
