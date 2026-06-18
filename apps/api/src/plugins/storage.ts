import fp from "fastify-plugin";
import { createS3Adapter } from "../adapters/s3Adapter.js";
import { createFsAdapter } from "../adapters/storage/fsAdapter.js";
import type { StorageAdapter } from "../adapters/storage/types.js";

declare module "fastify" {
  interface FastifyInstance {
    storage: StorageAdapter;
  }
}

/**
 * Decorate `app.storage` with the configured backend adapter. Must be
 * registered after the `s3` plugin (so `app.s3` exists in S3 mode) and before
 * any plugin/route that uses `app.storage` (e.g. mediaServices).
 */
export default fp(
  async app => {
    const storage: StorageAdapter =
      app.config.STORAGE_DRIVER === "fs"
        ? createFsAdapter({
            basePath: app.config.STORAGE_FS_PATH!, // required by config superRefine in fs mode
            // Presign URLs are site-relative (/api/storage/blob/...); the browser
            // reaches them via the web app's /api rewrite, so cookies authenticate.
          })
        : createS3Adapter(app.s3!);

    app.decorate("storage", storage);
    app.log.info({ driver: app.config.STORAGE_DRIVER }, "storage adapter ready");
  },
  { name: "storage" },
);
