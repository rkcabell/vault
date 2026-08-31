import fp from "fastify-plugin";
import { createFsAdapter } from "../adapters/storage/fsAdapter.js";
import type { StorageAdapter } from "../adapters/storage/types.js";

declare module "fastify" {
  interface FastifyInstance {
    storage: StorageAdapter;
  }
}

/**
 * Puts the filesystem storage adapter on the Fastify instance, which is how
 * everything reads and writes thumbnails and other derived files.
 *
 * Register this before any plugin or route that reads `app.storage`.
 */
export default fp(
  async app => {
    const storage = createFsAdapter({ basePath: app.config.STORAGE_FS_PATH });
    app.decorate("storage", storage);
    app.log.info({ basePath: app.config.STORAGE_FS_PATH }, "storage adapter ready (filesystem)");
  },
  { name: "storage" },
);
