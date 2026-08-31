/**
 * Puts the preferences service on the Fastify instance for routes to use.
 */
import fp from "fastify-plugin";
import { PreferencesService } from "../services/preferencesService.js";
import { PreferencesRepository } from "../repositories/preferencesRepository.js";

declare module "fastify" {
  interface FastifyInstance {
    preferencesService: PreferencesService;
  }
}

export default fp(
  async app => {
    app.decorate("preferencesService", new PreferencesService(new PreferencesRepository(app.prisma)));
  },
  { name: "preferencesService" },
);
