import fp from "fastify-plugin";
import { MediaRepository } from "../repositories/mediaRepository.js";
import { createDerivativeProgressTracker, type DerivativeProgressTracker } from "../services/media/derivativeProgress.js";

/**
 * Builds the derivative progress tracker, one per API process, and decorates
 * `app.derivativeProgress` with it.
 */

declare module "fastify" {
  interface FastifyInstance {
    derivativeProgress: DerivativeProgressTracker;
  }
}

export default fp(
  async app => {
    const tracker = createDerivativeProgressTracker({
      repository: new MediaRepository(app.prisma),
    });
    app.decorate("derivativeProgress", tracker);
  },
  { name: "derivativeProgress", dependencies: ["prisma"] },
);
