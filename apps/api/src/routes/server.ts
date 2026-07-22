import type { FastifyPluginAsync } from "fastify";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { access, mkdir, readFile, readdir, statfs, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Queue } from "bullmq";
import { requireAuth } from "../utils/authGuard.js";
import { buildRedisConnection } from "../lib/config/redis.js";
import { readObjectBuffer } from "../adapters/storage/getObjectBuffer.js";
import { normalizeExtensions } from "../lib/media/extensions.js";
import { canonicalizeAbsPath, overlapsStoragePath } from "../lib/media/indexRoots.js";
import { BUILD_DIR_NAMES, BUILD_DIR_SUFFIXES, CONTENT_EXTENSIONS } from "../lib/media/contentFilters.js";

/**
 * Find the .env the process is actually reading from. pnpm 10 pre-loads the
 * workspace root .env into the environment before spawning scripts, so
 * process.cwd() (.../apps/api) is NOT the right target — the root is.
 * Walk up from cwd looking for pnpm-workspace.yaml (workspace root marker);
 * if found and a .env exists there, use that. Otherwise fall back to cwd.
 */
function resolveEnvPath (): string {
  if (process.env.DOTENV_CONFIG_PATH) return process.env.DOTENV_CONFIG_PATH;
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) {
      return path.join(dir, ".env");
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.join(process.cwd(), ".env");
}

/**
 * Double-quote and escape a value for writing to a .env file.
 * Double-quoting is safe for all values: dotenv unescapes `\"` and `\\` but
 * does NOT expand `$` (that requires dotenv-expand), so secrets with `$` or
 * Windows paths with `\` are preserved correctly.
 */
function envValue (v: string): string {
  return `"${v.replace(/["\\]/g, "\\$&")}"`;
}

/**
 * Insert or replace `KEY=value` lines in an .env file's text, preserving all
 * other lines (including comments). Commented `# KEY=` lines are left untouched;
 * an active uncommented assignment is added if none exists.
 */
function upsertEnvContent (content: string, updates: Record<string, string>): string {
  const keys = new Set(Object.keys(updates));
  const seen = new Set<string>();
  const next = content.split(/\r?\n/).map(line => {
    const m = line.match(/^([A-Z0-9_]+)=/);
    if (m && keys.has(m[1])) {
      seen.add(m[1]);
      return `${m[1]}=${envValue(updates[m[1]])}`;
    }
    return line;
  });
  for (const k of keys) if (!seen.has(k)) next.push(`${k}=${envValue(updates[k])}`);
  return next.join("\n").replace(/\n{3,}/g, "\n\n");
}

type DriveRoot = { path: string; freeBytes: number | null; totalBytes: number | null };

/** Discover filesystem root paths: Windows drive letters, or "/" on POSIX. */
async function discoverRootPaths (): Promise<string[]> {
  if (process.platform === "win32") {
    const roots: string[] = [];
    for (let c = 67; c <= 90; c++) {
      // start at C:
      const root = `${String.fromCharCode(c)}:\\`;
      try {
        await access(root);
        roots.push(root);
      } catch {
        /* drive not present */
      }
    }
    return roots.length ? roots : ["C:\\"];
  }
  return ["/"];
}

/** Roots annotated with available/total space (null when the drive can't be queried). */
async function listDriveRoots (): Promise<DriveRoot[]> {
  const paths = await discoverRootPaths();
  return Promise.all(
    paths.map(async (p): Promise<DriveRoot> => {
      try {
        const s = await statfs(p);
        // bavail = blocks available to an unprivileged user; bsize = block size.
        return {
          path: p,
          freeBytes: Number(s.bavail) * Number(s.bsize),
          totalBytes: Number(s.blocks) * Number(s.bsize),
        };
      } catch {
        return { path: p, freeBytes: null, totalBytes: null };
      }
    }),
  );
}

/** Walk up from `start` until a readable directory is found (so the picker never dead-ends). */
async function nearestReadableDir (start: string): Promise<string> {
  let cur = path.resolve(start);
  for (let i = 0; i < 64; i++) {
    try {
      await readdir(cur);
      return cur;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return cur;
      cur = parent;
    }
  }
  return cur;
}

export const serverRoutes: FastifyPluginAsync = async (app) => {
  app.get("/status", { preHandler: [requireAuth] }, async () => {
    const mem = process.memoryUsage();

    return {
      env:            app.config.NODE_ENV,
      apiPort:        app.config.PORT,
      corsOrigin:     app.config.CORS_ORIGIN,
      uptimeSeconds:  process.uptime(),
      memoryMB:       Math.round(mem.rss / 1024 / 1024),
      storageDriver:  "fs",
      storagePath:    app.config.STORAGE_FS_PATH,
      // Whether the server can open a native file manager on the host. Drives
      // the "Open in File Explorer" button visibility on the media detail page.
      localExplorer:  app.config.LOCAL_EXPLORER,
    };
  });

  app.get("/storage", { preHandler: [requireAuth] }, async () => {
    const { sizeBytes, objectCount } = await app.storage.usage({ bucket: app.config.STORAGE_BUCKET });

    const [{ db_size }] = await app.prisma.$queryRaw<[{ db_size: bigint }]>`
      SELECT pg_database_size(current_database()) AS db_size
    `;

    return { sizeBytes, objectCount, dbSizeBytes: Number(db_size) };
  });

  // Round-trip a tiny probe object (put → get → delete) to verify the active
  // storage backend is reachable and writable. Surfaces typed errors so the
  // settings UI can show an actionable message (EACCES, ENOSPC, S3 auth, ...).
  app.post("/storage/test", { preHandler: [requireAuth] }, async (_req, reply) => {
    const bucket = app.config.STORAGE_BUCKET;
    // Flat key (no slash) so the fs adapter creates no subdirectory to clean up.
    const key = `_healthcheck-${randomUUID()}.txt`;
    const payload = Buffer.from(`vault-storage-test ${new Date().toISOString()}`);
    const started = Date.now();
    try {
      await app.storage.putObject({ bucket, key, body: payload, contentType: "text/plain" });
      // Read the object fully via readObjectBuffer — it consumes the stream with
      // error handlers attached, so a read failure resolves to null instead of
      // emitting an unhandled 'error' event (which would crash the process).
      // Read BEFORE delete so we never race the open() against the unlink.
      const readBack = await readObjectBuffer(app.storage, bucket, key);
      if (!readBack || !readBack.equals(payload)) {
        throw new Error("READBACK_FAILED: object not readable after write");
      }
      await app.storage.deleteIfPresent({ bucket, key });
      return { ok: true, driver: "fs", durationMs: Date.now() - started };
    } catch (err) {
      const code = (err as { code?: string }).code ?? null;
      const message = err instanceof Error ? err.message : String(err);
      app.log.warn({ err }, "storage self-test failed");
      // Best-effort cleanup; ignore failures.
      await app.storage.deleteIfPresent({ bucket, key }).catch(() => {});
      return reply.code(503).send({ ok: false, driver: "fs", code, message });
    }
  });

  // Current storage config for pre-filling the settings form.
  app.get("/storage-config", { preHandler: [requireAuth] }, async () => {
    const c = app.config;
    return {
      driver: "fs" as const,
      fsPath: c.STORAGE_FS_PATH,
      // Writing the env file only makes sense where it's the source of truth.
      // In production the env comes from the container/compose, so disable it.
      canApply: c.NODE_ENV !== "production",
    };
  });

  // Write the storage path to the .env file the API loaded, so the user can
  // repoint storage and just restart (we deliberately do NOT auto-restart —
  // a process can't reliably restart itself across the multi-process dev setup).
  // Dev / bare-metal only: in production the env is owned by the deployment.
  app.patch("/storage-config", { preHandler: [requireAuth] }, async (req, reply) => {
    if (app.config.NODE_ENV === "production") {
      return reply.forbidden(
        "Editing storage config from the app is disabled in production. Set env vars in your deployment and restart.",
      );
    }

    const body = (req.body ?? {}) as { fsPath?: unknown };
    const fsPath = typeof body.fsPath === "string" ? body.fsPath.trim() : "";
    if (!fsPath) return reply.badRequest("fsPath is required");
    if (!(fsPath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(fsPath))) {
      return reply.badRequest("fsPath must be an absolute path");
    }
    const updates: Record<string, string> = { STORAGE_FS_PATH: fsPath };

    const envPath = resolveEnvPath();
    let content = "";
    try {
      content = await readFile(envPath, "utf8");
    } catch (err) {
      if ((err as { code?: string }).code !== "ENOENT") throw err;
    }
    const updated = upsertEnvContent(content, updates);
    try {
      await writeFile(envPath, updated.endsWith("\n") ? updated : `${updated}\n`, "utf8");
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "EACCES" || code === "EPERM") return reply.forbidden("Cannot write env file (permission denied).");
      throw err;
    }

    return { ok: true, restartRequired: true, driver: "fs", envPath };
  });

  // Current in-place indexing allow-list + filetype blacklist, for pre-filling
  // the settings form. `skipInfo` describes what the built-in skipNonContent
  // filter actually does, so the UI can show the real lists instead of a
  // hardcoded copy that drifts out of sync.
  app.get("/index-config", { preHandler: [requireAuth] }, async (req) => {
    const prefs = await app.preferencesService.getPreferences(req.userId!);
    return {
      roots: prefs.indexAllowedRoots,
      blacklist: prefs.indexBlacklistExtensions,
      excludeFolders: prefs.indexExcludeFolders,
      skipNonContent: prefs.indexSkipNonContent,
      skipInfo: {
        buildDirNames: [...BUILD_DIR_NAMES].sort(),
        buildDirSuffixes: [...BUILD_DIR_SUFFIXES],
        contentExtensions: [...CONTENT_EXTENSIONS].sort(),
      },
    };
  });

  // Save the in-place indexing allow-list + filetype blacklist to user
  // preferences. Takes effect immediately — no restart needed.
  app.patch("/index-config", { preHandler: [requireAuth] }, async (req, reply) => {
    const body = (req.body ?? {}) as { roots?: unknown; blacklist?: unknown; excludeFolders?: unknown; skipNonContent?: unknown };
    if (!Array.isArray(body.roots)) return reply.badRequest("roots must be an array of absolute paths");

    // Validate + dedupe a list of absolute paths (shared by roots + excludeFolders).
    const toAbsolutePaths = (raw: unknown[], label: string): string[] | { error: string } => {
      const out: string[] = [];
      for (const item of raw) {
        if (typeof item !== "string") return { error: `each ${label} must be a string` };
        const trimmed = item.trim();
        if (!trimmed) continue; // drop blanks
        if (!(trimmed.startsWith("/") || /^[A-Za-z]:[\\/]/.test(trimmed))) {
          return { error: `Not an absolute path: ${trimmed}` };
        }
        out.push(trimmed);
      }
      return Array.from(new Set(out));
    };

    const rootsResult = toAbsolutePaths(body.roots, "root");
    if (!Array.isArray(rootsResult)) return reply.badRequest(rootsResult.error);
    // Canonicalize (resolves separators + drive-letter case on Windows) and
    // re-dedupe, so `E:/data` and `e:\data` can't be saved as two roots.
    const unique = Array.from(new Set(rootsResult.map(canonicalizeAbsPath)));

    // An index root inside Vault-managed storage (or containing it) would make
    // the indexer catalog Vault's own blobs/thumbnails as documents.
    const clash = unique.find(root => overlapsStoragePath(root, app.config.STORAGE_FS_PATH));
    if (clash) {
      return reply.badRequest(
        `Indexing root overlaps Vault's own storage folder (${app.config.STORAGE_FS_PATH}): ${clash}`,
      );
    }

    // blacklist is optional; when omitted the existing value is left untouched.
    let blacklist: string[] | undefined;
    if (body.blacklist !== undefined) {
      if (!Array.isArray(body.blacklist)) return reply.badRequest("blacklist must be an array of extensions");
      if (body.blacklist.some(e => typeof e !== "string")) return reply.badRequest("each extension must be a string");
      blacklist = normalizeExtensions(body.blacklist as string[]);
    }

    // excludeFolders is optional; when omitted the existing value is left untouched.
    let excludeFolders: string[] | undefined;
    if (body.excludeFolders !== undefined) {
      if (!Array.isArray(body.excludeFolders)) return reply.badRequest("excludeFolders must be an array of absolute paths");
      const result = toAbsolutePaths(body.excludeFolders, "excluded folder");
      if (!Array.isArray(result)) return reply.badRequest(result.error);
      excludeFolders = result;
    }

    // skipNonContent is optional; when omitted the existing value is left untouched.
    let skipNonContent: boolean | undefined;
    if (body.skipNonContent !== undefined) {
      if (typeof body.skipNonContent !== "boolean") return reply.badRequest("skipNonContent must be a boolean");
      skipNonContent = body.skipNonContent;
    }

    await app.preferencesService.updatePreferences(req.userId!, {
      indexAllowedRoots: unique,
      ...(blacklist !== undefined ? { indexBlacklistExtensions: blacklist } : {}),
      ...(excludeFolders !== undefined ? { indexExcludeFolders: excludeFolders } : {}),
      ...(skipNonContent !== undefined ? { indexSkipNonContent: skipNonContent } : {}),
    });
    return {
      ok: true,
      roots: unique,
      ...(blacklist !== undefined ? { blacklist } : {}),
      ...(excludeFolders !== undefined ? { excludeFolders } : {}),
      ...(skipNonContent !== undefined ? { skipNonContent } : {}),
    };
  });

  // Browse server-side directories so the settings UI can pick STORAGE_FS_PATH
  // (which lives on the server/container, not the user's machine). Read-only,
  // directories only, auth-gated. The single authenticated user is the admin,
  // so enumerating directory names is within this app's threat model.
  app.get("/fs/list", { preHandler: [requireAuth] }, async (req, reply) => {
    const requested = (req.query as { path?: string }).path;
    // Default to the server user's home dir (always exists), not STORAGE_FS_PATH
    // which the user may be in the middle of choosing. Fall back to the nearest
    // readable ancestor so a non-existent/typed path never dead-ends.
    const start = requested && requested.trim() ? requested : os.homedir();
    const target = await nearestReadableDir(start);
    const roots = await listDriveRoots();
    try {
      const entries = await readdir(target, { withFileTypes: true });
      const dirs = entries
        .filter(e => e.isDirectory())
        .map(e => ({ name: e.name, path: path.join(target, e.name) }))
        .sort((a, b) => a.name.localeCompare(b.name));
      const parent = path.dirname(target);
      const redirected = !!requested && path.resolve(requested) !== target;
      return { path: target, parent: parent === target ? null : parent, dirs, roots, redirected };
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "EACCES" || code === "EPERM") return reply.forbidden("Permission denied");
      throw err;
    }
  });

  // Create a single new directory inside an existing one (non-recursive), so the
  // settings UI can make a destination folder while choosing STORAGE_FS_PATH.
  app.post("/fs/mkdir", { preHandler: [requireAuth] }, async (req, reply) => {
    const { parent, name } = (req.body ?? {}) as { parent?: unknown; name?: unknown };
    if (typeof parent !== "string" || !parent.trim()) return reply.badRequest("parent is required");
    if (typeof name !== "string") return reply.badRequest("name is required");

    const trimmed = name.trim();
    // Reject empty, dot-names, and any path separators / reserved chars so the
    // new folder is created strictly inside `parent` (no traversal).
    if (!trimmed || trimmed === "." || trimmed === ".." || /[/\\:*?"<>|]/.test(trimmed)) {
      return reply.badRequest("Invalid folder name");
    }

    const target = path.join(path.resolve(parent), trimmed);
    try {
      await mkdir(target); // non-recursive: parent must already exist
      return reply.code(201).send({ path: target });
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "EEXIST") return reply.conflict("A folder with that name already exists");
      if (code === "EACCES" || code === "EPERM") return reply.forbidden("Permission denied");
      if (code === "ENOENT") return reply.notFound("Parent folder not found");
      throw err;
    }
  });

  app.get("/workers", { preHandler: [requireAuth] }, async () => {
    const OCR_QUEUE   = process.env.OCR_QUEUE   ?? "ocr_queue";
    const THUMB_QUEUE = process.env.THUMB_QUEUE ?? "thumb_queue";
    const connection  = buildRedisConnection(app.config.REDIS_URL);

    const ocrQueue   = new Queue(OCR_QUEUE,   { connection });
    const thumbQueue = new Queue(THUMB_QUEUE, { connection });

    try {
      const [ocrWorkers, thumbWorkers] = await Promise.all([
        ocrQueue.getWorkers(),
        thumbQueue.getWorkers(),
      ]);
      const [ocrCounts, thumbCounts] = await Promise.all([
        ocrQueue.getJobCounts("waiting", "active", "delayed", "failed"),
        thumbQueue.getJobCounts("waiting", "active", "delayed", "failed"),
      ]);
      return {
        ocr:   { active: ocrWorkers.length   > 0, count: ocrWorkers.length,   counts: ocrCounts   },
        thumb: { active: thumbWorkers.length > 0, count: thumbWorkers.length, counts: thumbCounts },
      };
    } finally {
      await Promise.allSettled([ocrQueue.close(), thumbQueue.close()]);
    }
  });

};
