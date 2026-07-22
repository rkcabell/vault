import fp from "fastify-plugin";
import { createFsAdapter } from "../adapters/storage/fsAdapter.js";
import type { StorageAdapter } from "../adapters/storage/types.js";

declare module "fastify" {
  interface FastifyInstance {
    storage: StorageAdapter;
  }
}

/**
 * Decorate `app.storage` with the filesystem storage adapter. Must be
 * registered before any plugin/route that uses `app.storage` (e.g.
 * mediaServices). Blobs live under STORAGE_FS_PATH; the browser reaches them
 * through the authenticated proxy routes in `routes/storage.ts` — presign URLs
 * are site-relative (/api/storage/blob/...), so cookies authenticate.
 */
export default fp(
  async app => {
    const storage = createFsAdapter({ basePath: app.config.STORAGE_FS_PATH });
    app.decorate("storage", storage);
    app.log.info({ basePath: app.config.STORAGE_FS_PATH }, "storage adapter ready (filesystem)");
  },
  { name: "storage" },
);
