import test from "node:test";
import Fastify from "fastify";
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import sensible from "@fastify/sensible";

/**
 * A Fastify app stubbing **every** service in `MediaServices`, so a route test
 * only names the calls it asserts on.
 *
 * Typecheck cannot catch a missing stub (tests decorate through `as any`), so
 * this default set is the only thing between a new route and a 500 that reads
 * like a route bug. Add a stub here when a service grows a method a route calls.
 *
 * `derivativeFeeder` and `jobEvents` are left undecorated: their absence is the
 * fallback path under test.
 */

type Stubs = Record<string, Record<string, any>>;

/**
 * Read defaults answer "nothing there"; **write defaults answer success**, so a
 * test that forgets to stub a mutating call still passes. That is the accepted
 * cost of letting an unrelated route's smoke test run without wiring all eleven
 * services — the mitigation is that every returned id is a fixed sentinel
 * ("job-1", "index-job-1"…) which no real assertion would match by accident.
 */
const defaultServices = (): Stubs => ({
  ingestService: {
    resolveTarget: async () => ({ enabled: false, reason: "no-roots" }),
    ingestFile: async () => null,
  },
  queryService: {
    listMedia: async () => ({ items: [], nextCursor: null }),
    listTopTags: async () => [],
    listAllSizes: async () => ({ tiles: [], totalFiles: 0, totalBytes: 0 }),
    getStats: async () => ({ count: 0, totalBytes: 0, byType: [] }),
    getCategoryBreakdown: async () => [],
    countScannedAwaitingOcr: async () => 0,
  },
  readService: {
    getMediaDetail: async () => null,
    getThumbnail: async () => null,
    getTextChunk: async () => null,
    getTextQueuePosition: async () => null,
    getSourceStream: async () => null,
    getStorageKey: async () => null,
  },
  actionsService: {
    deleteMedia: async () => null,
    updateMediaMetadata: async () => null,
    toggleStar: async () => null,
    getDownloadUrl: async () => null,
    enqueueTextExtraction: async () => null,
    cancelTextExtraction: async () => null,
    regenerateThumbnail: async () => null,
    regenerateThumbnailsBatch: async () => ({ queued: 0, missing: 0 }),
    enqueueTextExtractionBatch: async () => ({ queued: 0, missing: 0 }),
    extractAllScannedText: async () => ({ queued: 0, remaining: 0 }),
    prioritizeThumbnail: async () => ({ ok: false }),
  },
  archiveService: {
    getBulkDownloadItems: async () => [],
    streamBulkArchive: async () => {},
    unpackArchive: async () => null,
    enqueueUnpackForArchives: async () => ({ queued: 0 }),
  },
  jobControlService: {
    abortProcessing: async () => ({ ok: true, cleared: [] }),
    abortReconcile: async () => ({ ok: true, cleared: [] }),
  },
  indexService: {
    startIndex: async () => ({ ok: true, jobId: "index-job-1" }),
    getStatus: async () => null,
    getActive: async () => null,
  },
  reconcileService: {
    startReconcile: async () => ({ ok: true, jobIds: ["reconcile-job-1"] }),
    getState: async () => ({ running: null, last: null }),
  },
  deleteService: {
    startDelete: async () => ({ jobId: "job-1" }),
    getStatus: async () => null,
    getActive: async () => null,
    abort: async () => ({ epoch: 1 }),
  },
  organizeService: {
    startRun: async () => ({ jobId: "organize-job-1" }),
    getStatus: async () => null,
    getActive: async () => null,
  },
  dedupService: {
    listDuplicateGroups: async () => ({ groups: [], unhashedReady: 0 }),
    startScan: async () => ({ queued: 0 }),
  },
});

export type RouteAppOptions = {
  /** Per-service method overrides, merged over the defaults above. */
  services?: Stubs;
  /** `app.prisma`. Only `media.findFirst` is reached from the media routes. */
  prisma?: Record<string, any>;
  /** What `preferencesService.getPreferences` resolves to. */
  preferences?: Record<string, unknown>;
  /** Merged over the default `app.config`. */
  config?: Record<string, unknown>;
  /** Extra decorations — `derivativeFeeder`, `jobEvents`, anything else.
   *  Also how you replace the no-op `userRateLimit` with one that 429s. */
  decorate?: Record<string, unknown>;
  /** Registered before the plugins, so it sees every route they declare.
   *  mounting.test.ts is the reason this exists. */
  onRoute?: (route: { method: string | string[]; url: string }) => void;
  /** Mount the plugins under a prefix. Only mounting.test.ts needs one — every
   *  other test injects at the bare path. */
  prefix?: string;
};

const appsToClose: FastifyInstance[] = [];
test.after(async () => {
  await Promise.all(appsToClose.map(app => app.close()));
});

export async function buildRouteApp (
  plugins: FastifyPluginAsync | FastifyPluginAsync[],
  opts: RouteAppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(sensible);

  (app as any).decorate("jwt", {
    verifyAccess: () => ({ sub: "user-1" }),
    signAccess: () => "",
    signRefresh: () => "",
    verifyRefresh: () => ({ sub: "user-1" }),
  });

  const services = defaultServices();
  for (const [name, methods] of Object.entries(opts.services ?? {})) {
    services[name] = { ...services[name], ...methods };
  }
  (app as any).decorate("mediaServices", services);

  (app as any).decorate("prisma", {
    user: { findUnique: async () => null },
    media: { findMany: async () => [], findFirst: async () => null },
    ...opts.prisma,
  });

  (app as any).decorate("preferencesService", {
    getPreferences: async () => ({
      autoTagOnIngest: true,
      autoUnpackArchives: false,
      ...opts.preferences,
    }),
  });

  (app as any).decorate("config", {
    REDIS_URL: "redis://localhost:6379",
    STORAGE_FS_PATH: "/data/vault",
    // Off by default so no test can spawn a real file manager by accident.
    LOCAL_EXPLORER: false,
    ...opts.config,
  });

  // Routes attach a limiter at *registration* time, so these must exist before
  // the plugins load or the route file throws. No-ops by default: a route test
  // asserts the route, not its bucket. Override via `decorate` to assert a 429.
  const decorations: Record<string, unknown> = {
    rateLimit: () => async () => {},
    userRateLimit: () => async () => {},
    ...opts.decorate,
  };
  for (const [name, value] of Object.entries(decorations)) {
    (app as any).decorate(name, value);
  }

  if (opts.onRoute) app.addHook("onRoute", opts.onRoute as any);

  for (const plugin of Array.isArray(plugins) ? plugins : [plugins]) {
    await app.register(plugin, opts.prefix ? { prefix: opts.prefix } : undefined);
  }

  appsToClose.push(app);
  return app;
}

export const AUTH = { authorization: "Bearer test-token" };
export const JSON_HEADERS = { ...AUTH, "content-type": "application/json" };
/** Any valid UUID — used as a stand-in media/param ID throughout. */
export const ID = "00000000-0000-0000-0000-000000000001";
