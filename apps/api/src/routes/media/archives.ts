/**
 * Serves the archive routes: unpacking one into a bundle, and unpacking those
 * that arrive in the library already.
 */
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireAuth } from "../../utils/authGuard.js";
import { paramsSchema } from "./shared.js";

const MAX_BATCH_ITEMS = 100;

export const mediaArchiveRoutes: FastifyPluginAsync = async app => {
  const { archiveService } = app.mediaServices;

  // Unpacks archives among the ids given, if the user has asked for that to
  // happen automatically. Indexing creates the rows; this only decides whether
  // to open them.
  app.post("/unpack-new", { preHandler: [requireAuth] }, async req => {
    const body = z
      .object({
        ids: z.array(z.string().uuid()).min(1).max(MAX_BATCH_ITEMS),
        autoUnpack: z.boolean().optional(),
      })
      .parse(req.body);

    const userId = req.userId!;
    const prefs = await app.preferencesService.getPreferences(userId).catch(() => null);
    const autoUnpack = body.autoUnpack !== undefined
      ? body.autoUnpack
      : prefs?.autoUnpackArchives ?? false;

    // `count` is how many ids were submitted and `queued` how many unpack jobs
    // now exist. The service logs a failed enqueue instead of raising, so
    // reporting `count` alone would present a failure as a success.
    let queued = 0;
    if (autoUnpack) {
      ({ queued } = await archiveService.enqueueUnpackForArchives(
        userId,
        body.ids,
        prefs?.indexAllowedRoots ?? [],
      ));
    }

    return { ok: true, count: body.ids.length, queued };
  });

  // Unpacks one archive into a new bundle. An archive already unpacked is
  // refused rather than unpacked a second time.
  app.post<{ Params: { id: string } }>(
    "/:id/unpack",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const userId = req.userId!;
      const { id } = paramsSchema.parse(req.params);

      const prefs = await app.preferencesService.getPreferences(userId).catch(() => null);
      const result = await archiveService.unpackArchive(userId, id, prefs?.indexAllowedRoots ?? []);

      if (!result) return reply.notFound();
      if (result === "not-archive") {
        return reply.badRequest("File is not a recognised archive type.");
      }
      if (result === "already-linked") {
        return reply.code(409).send({ error: "Archive is already linked to a bundle." });
      }

      req.log.info({ mediaId: id, bundleId: result.bundleId }, "archive unpacked");
      return reply.send({ bundleId: result.bundleId });
    },
  );
};
