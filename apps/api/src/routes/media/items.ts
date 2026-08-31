/**
 * Serves the routes that act on one media item: reading its detail page,
 * editing it, starring it, deleting it, and opening it in the file manager.
 */
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { execFile, spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { requireAuth } from "../../utils/authGuard.js";
import { normalizeTags, TagValidationError } from "../../lib/tags/normalizeTags.js";
import { isUnderAllowedRoot } from "../../lib/media/indexRoots.js";
import { resolveStorageKeyPath } from "../../adapters/storage/fsAdapter.js";
import { paramsSchema } from "./shared.js";

type MinLogger = { warn: (obj: object, msg: string) => void };

/**
 * Opens the system file manager with `p` selected.
 *
 * Failure is logged rather than reported: the request has already succeeded by
 * the time the file manager is asked to open.
 */
function revealInExplorer (p: string, log: MinLogger) {
  if (process.platform === "win32") {
    // explorer.exe accepts one form only: `/select,"<path>"`, with the quotes
    // around the path and nowhere else.
    //
    // Running it through `cmd /c start` breaks the flag, because cmd splits the
    // argument on the comma in `/select,`. Letting Node quote the argument
    // breaks it too, because Node wraps the whole `/select,<path>` token once
    // the path contains a space, and explorer then ignores the flag and opens
    // the default folder instead.
    //
    // windowsVerbatimArguments hands the string over untouched, so the quotes
    // stay where explorer wants them. A Windows filename cannot contain a
    // double quote, so nothing in the path can end the quoting early.
    const winPath = p.replace(/\//g, "\\");
    const child = spawn("explorer.exe", [`/select,"${winPath}"`], {
      windowsVerbatimArguments: true,
      detached: true,
      stdio: "ignore",
    });
    // 'error' fires only on spawn failure; explorer's nonzero exit is not surfaced.
    child.on("error", err => log.warn({ err, path: p }, "reveal in explorer failed"));
    child.unref();
  } else if (process.platform === "darwin") {
    execFile("open", ["-R", p], err => {
      if (err) log.warn({ err, path: p }, "reveal in explorer failed");
    });
  } else {
    execFile("xdg-open", [path.dirname(p)], err => {
      if (err) log.warn({ err, path: p }, "reveal in explorer failed");
    });
  }
}

/** Everything that acts on a single item, as opposed to a selection of them. */
export const mediaItemsRoutes: FastifyPluginAsync = async app => {
  const { readService, actionsService } = app.mediaServices;

  // Not a bare path.join: the reveal route spawns a file manager on the result.
  const storageKeyPath = (key: string) => resolveStorageKeyPath(app.config.STORAGE_FS_PATH, key);

  const parseTags = (value: unknown) => {
    try {
      return normalizeTags(value);
    } catch (error) {
      if (error instanceof TagValidationError) throw app.httpErrors.badRequest(error.message);
      throw error;
    }
  };

  // Deletes one item straight away. A selection is deleted through the delete
  // worker instead; see deleteJobs.ts.
  app.delete<{ Params: { id: string } }>(
    "/:id",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const userId = req.userId!;
      const { id } = paramsSchema.parse(req.params);

      const result = await actionsService.deleteMedia(userId, id);

      if (!result) return reply.notFound();

      req.log.info({ mediaId: id }, "media deleted");
      return reply.send(result);
    },
  );

  // Changes an item's title, its tags, or both. Sending tags replaces the whole
  // set rather than adding to it.
  app.patch<{ Params: { id: string } }>(
    "/:id",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const userId = req.userId!;
      const { id } = paramsSchema.parse(req.params);
      const body = z
        .object({
          title: z.string().min(1).optional(),
          tags: z.unknown().optional(),
        })
        .refine(data => data.title !== undefined || data.tags !== undefined, {
          message: "Provide a title or tags to update",
        })
        .parse(req.body);

      const hasTagsField = Object.prototype.hasOwnProperty.call(req.body ?? {}, "tags");
      const tags = hasTagsField ? parseTags(body.tags) : undefined;

      const media = await actionsService.updateMediaMetadata(userId, id, {
        title: body.title,
        tags,
      });

      if (!media) return reply.notFound();

      return reply.send({ media });
    },
  );

  // Stars an unstarred item or unstars a starred one.
  app.post<{ Params: { id: string } }>(
    "/:id/star",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const { id } = paramsSchema.parse(req.params);
      const starred = await actionsService.toggleStar(req.userId!, id);
      if (starred === null) return reply.notFound();
      req.log.info({ mediaId: id, starred }, "media star toggled");
      return { ok: true, starred };
    },
  );

  // The detail page for one item.
  app.get<{ Params: { id: string } }>("/:id", { preHandler: [requireAuth] }, async (req, reply) => {
    const userId = req.userId!;
    const { id } = paramsSchema.parse(req.params);

    const detail = await readService.getMediaDetail(userId, id);
    if (!detail) return reply.notFound();

    // Opening an item says it matters, so its thumbnail jumps the queue. The
    // request does not wait for that, and a queue failure must not stop the
    // page being served.
    //
    // This goes through the feeder because most waiting rows have no job in
    // Redis to reorder yet — reordering alone would do nothing at all.
    if (detail.media.thumbState === "PENDING") {
      const promote = app.derivativeFeeder
        ? app.derivativeFeeder.promoteThumbnails(userId, [id])
        : actionsService.prioritizeThumbnail(id);
      void Promise.resolve(promote).catch(err => {
        req.log.warn({ err, mediaId: id }, "[media] thumbnail prioritization failed");
      });
    }

    // Compute the local filesystem path for "Open in File Explorer".
    // In-place indexed items have sourcePath; managed uploads live at
    // STORAGE_FS_PATH/storageKey. media_source_xor guarantees one of the two.
    let localPath = detail.media.sourcePath ?? "";
    if (!localPath && detail.media.storageKey) {
      try {
        localPath = storageKeyPath(detail.media.storageKey);
      } catch (err) {
        req.log.warn({ err, mediaId: id }, "[media] storageKey escapes STORAGE_FS_PATH");
      }
    }

    return reply.send({ ...detail, localPath });
  });

  // Opens the item in the system file manager, on a server the user is sitting
  // at. Works for a file indexed where it lies and for one held in Vault's own
  // storage.
  app.post<{ Params: { id: string } }>(
    "/:id/reveal",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const userId = req.userId!;
      const { id } = paramsSchema.parse(req.params);

      // Refuse on deployments where the server can't reach the user's desktop
      // (remote/container/multi-user). The UI hides the button in this case too.
      if (!app.config.LOCAL_EXPLORER) {
        return reply.forbidden("File Explorer reveal is disabled on this server.");
      }

      const media = await readService.getStorageKey(userId, id);
      if (!media) return reply.notFound();

      let revealPath: string;
      if (media.sourcePath) {
        // In-place indexed: re-validate against current allow-list.
        const prefs = await app.preferencesService.getPreferences(userId).catch(() => null);
        const allowedRoots = prefs?.indexAllowedRoots ?? [];
        if (!isUnderAllowedRoot(media.sourcePath, allowedRoots)) {
          return reply.forbidden("Source path is no longer within an allowed root.");
        }
        revealPath = media.sourcePath;
      } else {
        // Vault-managed filesystem upload: construct the storage path.
        // media_source_xor guarantees storageKey is set whenever sourcePath isn't.
        if (!media.storageKey) return reply.notFound("File no longer exists at its recorded location.");
        try {
          revealPath = storageKeyPath(media.storageKey);
        } catch (err) {
          req.log.warn({ err, mediaId: id }, "[media] reveal refused: storageKey escapes STORAGE_FS_PATH");
          return reply.forbidden("File is outside Vault's storage folder.");
        }
      }

      // Fail loudly if the file is gone — otherwise Explorer silently falls back
      // to opening the default folder, which looks like the wrong file opened.
      try {
        await stat(revealPath);
      } catch {
        return reply.notFound("File no longer exists at its recorded location.");
      }

      revealInExplorer(revealPath, req.log);
      return reply.send({ ok: true });
    },
  );
};
