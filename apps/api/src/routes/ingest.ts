import type { FastifyPluginAsync } from "fastify";
import type { Readable } from "node:stream";
import path from "node:path";
import { requireAuth } from "../utils/authGuard.js";
import { UnsafeIngestFilenameError } from "../lib/media/ingestWrite.js";
import { HARD_UPLOAD_LIMIT_BYTES } from "../lib/media/ingestLimits.js";
import { STREAM_WRITE } from "../lib/http/rateLimits.js";
import {
  IngestNotConfiguredError,
  IngestTooLargeError,
  type IngestDisabledReason,
} from "../services/media/ingestService.js";

/**
 * Accepts files sent to Vault over HTTP. The bytes are written into a folder the
 * user chose inside their own index roots and indexed in the same request, so
 * what comes out is an ordinary indexed row.
 */

/** What the user has to do to make sending work, per disabled reason. */
const DISABLED_MESSAGE: Record<IngestDisabledReason, string> = {
  "no-roots": "Add a folder to index before sending files.",
  "not-set": "Choose the folder that sent files should be saved to.",
  "outside-roots": "The folder for sent files is no longer inside an indexed folder. Choose another.",
  missing: "The folder for sent files no longer exists. Choose another.",
};

export const ingestRoutes: FastifyPluginAsync = async app => {
  const { ingestService } = app.mediaServices;

  // Raw stream bodies, with no buffering and no bodyLimit, so a large file goes
  // straight to disk. It applies to this plugin only.
  app.addContentTypeParser("*", (_req, payload, done) => done(null, payload));

  // Answers even when sending is not configured: the page renders its setup
  // state from this, so it has to be able to say "not yet, and here is why".
  app.get("/config", { preHandler: [requireAuth] }, async req => {
    const target = await ingestService.resolveTarget(req.userId!);
    return {
      enabled: target.enabled,
      folderPath: target.folderPath,
      maxBytes: HARD_UPLOAD_LIMIT_BYTES,
      ...(target.enabled ? {} : { reason: target.reason, message: DISABLED_MESSAGE[target.reason] }),
    };
  });

  // The filename travels in the URL rather than a header so it survives
  // proxies untouched; only its basename is ever used.
  app.put<{ Params: Record<string, string> }>(
    "/file/*",
    { preHandler: [requireAuth, app.userRateLimit("ingest-file", STREAM_WRITE)] },
    async (req, reply) => {
      const raw = (req.params as { "*"?: string })["*"] ?? "";

      try {
        // Inside the try: a malformed percent-escape throws URIError, caught below.
        const requested = path.posix.basename(decodeURIComponent(raw));
        if (!requested) return reply.badRequest("A filename is required");

        const result = await ingestService.ingestFile(req.userId!, {
          filename: requested,
          body: req.body as Readable,
        });
        req.log.info(
          { mediaId: result.id, savedAs: result.savedAs, sizeBytes: result.sizeBytes },
          "ingest: file saved and indexed",
        );
        return reply.code(201).send(result);
      } catch (err) {
        if (err instanceof URIError) return reply.badRequest("Invalid filename encoding");
        if (err instanceof IngestNotConfiguredError) {
          return reply.conflict(DISABLED_MESSAGE[err.reason]);
        }
        if (err instanceof IngestTooLargeError) return reply.badRequest(err.message);
        if (err instanceof UnsafeIngestFilenameError) return reply.badRequest(err.message);
        throw err;
      }
    },
  );
};
