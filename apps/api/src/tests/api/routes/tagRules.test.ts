import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import sensible from "@fastify/sensible";
import { tagRulesRoutes } from "@/routes/tagRules.js";

// ── mock helpers ──────────────────────────────────────────────────────────────

type RuleRow = {
  id: string;
  userId: string;
  name: string;
  source: string;
  matcher: Record<string, unknown>;
  tagTemplate: string;
  priority: number;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
};

function makeRule (partial: Partial<RuleRow> & Pick<RuleRow, "id">): RuleRow {
  return {
    userId: "user-1",
    name: "Rule",
    source: "MIME",
    matcher: {},
    tagTemplate: "type:{value}",
    priority: 0,
    enabled: true,
    createdAt: new Date("2026-07-01T00:00:00Z"),
    updatedAt: new Date("2026-07-01T00:00:00Z"),
    ...partial,
  };
}

/** In-memory prisma.tagRule good enough for the repository's calls. */
function makePrisma (rows: RuleRow[] = []) {
  const state = [...rows];
  return {
    rows: state,
    tagRule: {
      findMany: async () => [...state],
      findFirst: async (args: { where: { id: string; userId: string } }) =>
        state.find(r => r.id === args.where.id && r.userId === args.where.userId) ?? null,
      create: async (args: { data: Omit<RuleRow, "id" | "createdAt" | "updatedAt"> }) => {
        const row: RuleRow = {
          id: `rule-${state.length + 1}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...args.data,
          matcher: (args.data.matcher ?? {}) as Record<string, unknown>,
        };
        state.push(row);
        return row;
      },
      updateMany: async (args: { where: { id: string; userId: string }; data: Partial<RuleRow> }) => {
        const row = state.find(r => r.id === args.where.id && r.userId === args.where.userId);
        if (!row) return { count: 0 };
        Object.assign(row, args.data, { updatedAt: new Date() });
        return { count: 1 };
      },
      deleteMany: async (args: { where: { id: string; userId: string } }) => {
        const i = state.findIndex(r => r.id === args.where.id && r.userId === args.where.userId);
        if (i < 0) return { count: 0 };
        state.splice(i, 1);
        return { count: 1 };
      },
      createMany: async () => ({ count: 0 }),
    },
  };
}

type OrganizeCalls = { runs: Array<{ userId: string; dryRun: boolean }> };

function makeOrganizeService (calls: OrganizeCalls, status: unknown = null) {
  return {
    startRun: async (userId: string, dryRun: boolean) => {
      calls.runs.push({ userId, dryRun });
      return { jobId: `organize-${userId}-123` };
    },
    getStatus: async (_userId: string, jobId: string) =>
      jobId === "organize-user-1-123" ? status : null,
    getActive: async () => status,
  };
}

async function buildApp (rows: RuleRow[] = [], organizeStatus: unknown = null) {
  const app = Fastify({ logger: false });
  await app.register(sensible);

  (app as any).decorate("jwt", {
    verifyAccess: () => ({ sub: "user-1" }),
    signAccess: () => "",
    signRefresh: () => "",
    verifyRefresh: () => ({ sub: "user-1" }),
  });

  const prisma = makePrisma(rows);
  (app as any).decorate("prisma", prisma);

  const calls: OrganizeCalls = { runs: [] };
  (app as any).decorate("mediaServices", { organizeService: makeOrganizeService(calls, organizeStatus) });

  await app.register(tagRulesRoutes);
  return { app, prisma, calls };
}

const AUTH = { authorization: "Bearer test-token" };
const JSON_HEADERS = { ...AUTH, "content-type": "application/json" };

// ── GET / ─────────────────────────────────────────────────────────────────────

test("GET /: returns serialized rules", async () => {
  const { app } = await buildApp([makeRule({ id: "r1", name: "File type" })]);

  const res = await app.inject({ method: "GET", url: "/", headers: AUTH });

  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.rules.length, 1);
  assert.equal(body.rules[0].id, "r1");
  assert.equal(body.rules[0].name, "File type");
  assert.equal(typeof body.rules[0].createdAt, "string");
});

// ── POST / ────────────────────────────────────────────────────────────────────

test("POST /: creates a rule with defaults applied", async () => {
  const { app, prisma } = await buildApp();

  const res = await app.inject({
    method: "POST",
    url: "/",
    headers: JSON_HEADERS,
    payload: { name: "Year", source: "FILE_DATE", matcher: { granularity: "year" }, tagTemplate: "year:{value}" },
  });

  assert.equal(res.statusCode, 201);
  const { rule } = res.json();
  assert.equal(rule.source, "FILE_DATE");
  assert.equal(rule.priority, 0);
  assert.equal(rule.enabled, true);
  assert.equal(prisma.rows.length, 1);
});

test("POST /: rejects a matcher that does not fit the source", async () => {
  const { app, prisma } = await buildApp();

  const res = await app.inject({
    method: "POST",
    url: "/",
    headers: JSON_HEADERS,
    payload: { name: "Bad", source: "FILE_DATE", matcher: { granularity: "decade" }, tagTemplate: "year:{value}" },
  });

  assert.equal(res.statusCode, 400);
  assert.match(res.json().message, /Invalid matcher for FILE_DATE/);
  assert.equal(prisma.rows.length, 0);
});

test("POST /: rejects a template that cannot produce a valid tag", async () => {
  const { app } = await buildApp();

  const res = await app.inject({
    method: "POST",
    url: "/",
    headers: JSON_HEADERS,
    payload: { name: "Bad", source: "MIME", matcher: {}, tagTemplate: "a:b:{value}" },
  });

  assert.equal(res.statusCode, 400);
  assert.match(res.json().message, /Invalid tag template/);
});

test("POST /: rejects an unknown source", async () => {
  const { app } = await buildApp();
  const res = await app.inject({
    method: "POST",
    url: "/",
    headers: JSON_HEADERS,
    payload: { name: "Bad", source: "AI_MAGIC", matcher: {}, tagTemplate: "x" },
  });
  assert.equal(res.statusCode, 400);
});

// ── PATCH /:id ────────────────────────────────────────────────────────────────

test("PATCH /:id: updates fields and revalidates the merged matcher", async () => {
  const { app } = await buildApp([makeRule({ id: "r1" })]);

  const res = await app.inject({
    method: "PATCH",
    url: "/r1",
    headers: JSON_HEADERS,
    payload: { enabled: false, priority: 5 },
  });

  assert.equal(res.statusCode, 200);
  const { rule } = res.json();
  assert.equal(rule.enabled, false);
  assert.equal(rule.priority, 5);
});

test("PATCH /:id: rejects a source change that invalidates the stored matcher", async () => {
  const { app } = await buildApp([
    makeRule({ id: "r1", source: "FILE_DATE", matcher: { granularity: "year" }, tagTemplate: "year:{value}" }),
  ]);

  // FILE_DATE matcher {granularity} is not valid for SIZE.
  const res = await app.inject({
    method: "PATCH",
    url: "/r1",
    headers: JSON_HEADERS,
    payload: { source: "SIZE" },
  });

  assert.equal(res.statusCode, 400);
  assert.match(res.json().message, /Invalid matcher for SIZE/);
});

test("PATCH /:id: 404 for a rule the user does not own", async () => {
  const { app } = await buildApp([makeRule({ id: "r1", userId: "someone-else" })]);
  const res = await app.inject({ method: "PATCH", url: "/r1", headers: JSON_HEADERS, payload: { enabled: false } });
  assert.equal(res.statusCode, 404);
});

test("PATCH /:id: empty body is rejected", async () => {
  const { app } = await buildApp([makeRule({ id: "r1" })]);
  const res = await app.inject({ method: "PATCH", url: "/r1", headers: JSON_HEADERS, payload: {} });
  assert.equal(res.statusCode, 400);
});

// ── DELETE /:id ───────────────────────────────────────────────────────────────

test("DELETE /:id: removes the rule; unknown id is 404", async () => {
  const { app, prisma } = await buildApp([makeRule({ id: "r1" })]);

  const ok = await app.inject({ method: "DELETE", url: "/r1", headers: AUTH });
  assert.equal(ok.statusCode, 200);
  assert.equal(prisma.rows.length, 0);

  const missing = await app.inject({ method: "DELETE", url: "/r1", headers: AUTH });
  assert.equal(missing.statusCode, 404);
});

// ── /run ──────────────────────────────────────────────────────────────────────

test("POST /run: enqueues a real run by default, a dry run with ?dryRun=true", async () => {
  const { app, calls } = await buildApp();

  const real = await app.inject({ method: "POST", url: "/run", headers: AUTH });
  assert.equal(real.statusCode, 200);
  assert.ok(real.json().jobId.startsWith("organize-user-1-"));

  const dry = await app.inject({ method: "POST", url: "/run?dryRun=true", headers: AUTH });
  assert.equal(dry.statusCode, 200);

  assert.deepEqual(calls.runs, [
    { userId: "user-1", dryRun: false },
    { userId: "user-1", dryRun: true },
  ]);
});

test("GET /run/status: returns the job status; unknown jobId is 404", async () => {
  const status = { jobId: "organize-user-1-123", state: "active", done: false };
  const { app } = await buildApp([], status);

  const found = await app.inject({ method: "GET", url: "/run/status?jobId=organize-user-1-123", headers: AUTH });
  assert.equal(found.statusCode, 200);
  assert.equal(found.json().state, "active");

  const missing = await app.inject({ method: "GET", url: "/run/status?jobId=organize-user-2-999", headers: AUTH });
  assert.equal(missing.statusCode, 404);
});

test("GET /run/active: returns { status: null } when idle", async () => {
  const { app } = await buildApp();
  const res = await app.inject({ method: "GET", url: "/run/active", headers: AUTH });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { status: null });
});
