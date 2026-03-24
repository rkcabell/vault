import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import sensible from "@fastify/sensible";
import { remindersRoutes } from "@/routes/reminders.js";

type ReminderListRow = {
  id: string;
  title: string;
  note: string | null;
  dueAt: Date;
  nextDueAt: Date | null;
  remindAt: Date;
  snoozedUntil: Date | null;
  timezone: string;
  remindOffsetDays: number | null;
  media: { id: string; title: string } | null;
};

type ReminderCompletedRow = {
  id: string;
  title: string;
  note: string | null;
  dueAt: Date;
  lastCompletedAt: Date | null;
  updatedAt: Date;
  media: { id: string; title: string } | null;
};

type ReminderRecord = {
  id: string;
  userId: string;
  title: string;
  note: string | null;
  mediaId: string | null;
  status: "ACTIVE" | "COMPLETED" | "CANCELED";
  timezone: string;
  dueAt: Date;
  nextDueAt: Date | null;
  remindOffsetDays: number | null;
  remindAt: Date;
  snoozedUntil: Date | null;
  rrule: string | null;
  lastCompletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

interface PrismaMockOpts {
  reminderCount?: (_args: unknown) => Promise<number>;
  reminderFindMany?: (_args: unknown) => Promise<ReminderListRow[] | ReminderCompletedRow[]>;
  reminderFindFirst?: (_args: unknown) => Promise<unknown>;
  reminderCreate?: (_args: unknown) => Promise<ReminderRecord>;
  reminderUpdate?: (_args: unknown) => Promise<ReminderRecord | unknown>;
  mediaFindFirst?: (_args: unknown) => Promise<{ id: string } | null>;
}

function makeReminderRecord(overrides: Partial<ReminderRecord> = {}): ReminderRecord {
  const now = new Date("2026-04-10T12:00:00.000Z");
  return {
    id: "00000000-0000-0000-0000-000000000111",
    userId: "user-1",
    title: "Reminder title",
    note: null,
    mediaId: null,
    status: "ACTIVE",
    timezone: "UTC",
    dueAt: new Date("2026-04-20T12:00:00.000Z"),
    nextDueAt: null,
    remindOffsetDays: null,
    remindAt: new Date("2026-04-13T12:00:00.000Z"),
    snoozedUntil: null,
    rrule: null,
    lastCompletedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makePrisma({
  reminderCount = async () => 0,
  reminderFindMany = async () => [],
  reminderFindFirst = async () => null,
  reminderCreate = async () => makeReminderRecord(),
  reminderUpdate = async () => makeReminderRecord(),
  mediaFindFirst = async () => ({ id: "media-1" }),
}: PrismaMockOpts = {}) {
  return {
    reminder: {
      count: reminderCount,
      findMany: reminderFindMany,
      findFirst: reminderFindFirst,
      create: reminderCreate,
      update: reminderUpdate,
    },
    media: {
      findFirst: mediaFindFirst,
    },
  };
}

async function buildApp(opts: PrismaMockOpts = {}) {
  const app = Fastify({ logger: false });
  await app.register(sensible);

   
  (app as any).decorate("jwt", {
    verifyAccess: () => ({ sub: "user-1" }),
    signAccess: () => "",
    signRefresh: () => "",
    verifyRefresh: () => ({ sub: "user-1" }),
  });

   
  (app as any).decorate("prisma", makePrisma(opts));

  await app.register(remindersRoutes);
  return app;
}

const AUTH = { authorization: "Bearer test-token" };
const JSON_HEADERS = { ...AUTH, "content-type": "application/json" };
const REMINDER_ID = "00000000-0000-0000-0000-000000000001";
const MEDIA_ID = "00000000-0000-0000-0000-000000000002";
const DAY_MS = 24 * 60 * 60 * 1000;

function makeOverviewRow(
  id: string,
  dueAt: Date,
  options: Partial<Omit<ReminderListRow, "id" | "title" | "note" | "dueAt" | "nextDueAt" | "remindAt" | "snoozedUntil" | "timezone" | "remindOffsetDays" | "media">> & {
    title?: string;
    remindAt?: Date;
    snoozedUntil?: Date | null;
    timezone?: string;
    remindOffsetDays?: number | null;
    media?: { id: string; title: string } | null;
    note?: string | null;
    nextDueAt?: Date | null;
  } = {},
): ReminderListRow {
  const now = new Date();
  return {
    id,
    title: options.title ?? `Reminder ${id}`,
    note: options.note ?? null,
    dueAt,
    nextDueAt: options.nextDueAt ?? null,
    remindAt: options.remindAt ?? new Date(now.getTime() - DAY_MS),
    snoozedUntil: options.snoozedUntil ?? null,
    timezone: options.timezone ?? "UTC",
    remindOffsetDays: options.remindOffsetDays ?? null,
    media: options.media ?? null,
  };
}

// -- GET /summary -------------------------------------------------------------

test("GET /summary: returns aggregate counts by bucket", async () => {
  const app = await buildApp({
    reminderCount: async () => 7,
    reminderFindMany: async (args) => {
      const now = (
        args as {
          where: {
            remindAt: { lte: Date };
          };
        }
      ).where.remindAt.lte;

      return [
        { dueAt: new Date(now.getTime() - 60_000), nextDueAt: null, timezone: "UTC" }, // overdue
        { dueAt: new Date(now.getTime() + 60_000), nextDueAt: null, timezone: "UTC" }, // today
        { dueAt: new Date(now.getTime() + 2 * DAY_MS), nextDueAt: null, timezone: "UTC" }, // soon
        { dueAt: new Date(now.getTime() + 20 * DAY_MS), nextDueAt: null, timezone: "UTC" }, // later
      ] as ReminderListRow[];
    },
  });

  const res = await app.inject({ method: "GET", url: "/summary", headers: AUTH });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.totalActive, 7);
  assert.equal(body.visibleNow, 4);
  assert.equal(body.overdue, 1);
  assert.equal(body.dueToday, 1);
  assert.equal(body.dueSoon, 1);
  assert.equal(body.soonWindowDays, 7);
});

test("GET /summary: unauthenticated returns 401", async () => {
  const app = await buildApp();
  const res = await app.inject({ method: "GET", url: "/summary" });
  assert.equal(res.statusCode, 401);
});

// -- GET / -------------------------------------------------------------------

test("GET /: status=canceled returns 400", async () => {
  const app = await buildApp();
  const res = await app.inject({
    method: "GET",
    url: "/?status=canceled",
    headers: AUTH,
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().message, /status=canceled is not supported/i);
});

test("GET /: status=completed requires view=all", async () => {
  const app = await buildApp();
  const res = await app.inject({
    method: "GET",
    url: "/?status=completed&view=overview",
    headers: AUTH,
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().message, /only view=all is supported for status=completed/i);
});

test("GET /: status=completed view=all returns completed reminders", async () => {
  const completedAt = new Date("2026-05-01T14:00:00.000Z");
  const updatedAt = new Date("2026-05-02T14:00:00.000Z");

  const app = await buildApp({
    reminderFindMany: async () =>
      [
        {
          id: REMINDER_ID,
          title: "Renew insurance",
          note: "Annual renewal",
          dueAt: new Date("2026-06-01T09:00:00.000Z"),
          lastCompletedAt: completedAt,
          updatedAt,
          media: { id: MEDIA_ID, title: "Insurance PDF" },
        },
      ] satisfies ReminderCompletedRow[],
  });

  const res = await app.inject({
    method: "GET",
    url: "/?status=completed&view=all&limit=5",
    headers: AUTH,
  });

  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].id, REMINDER_ID);
  assert.equal(body.items[0].title, "Renew insurance");
  assert.equal(body.items[0].lastCompletedAt, completedAt.toISOString());
});

test("GET /: overview backfills hidden reminders when visible count is below limit", async () => {
  let findManyCalls = 0;
  const app = await buildApp({
    reminderFindMany: async (args) => {
      const where = (args as { where: Record<string, unknown> }).where;
      const isVisibleQuery = "remindAt" in where;
      findManyCalls += 1;

      if (isVisibleQuery) {
        return [
          makeOverviewRow("visible-1", new Date(Date.now() + 3 * DAY_MS), {
            remindAt: new Date(Date.now() - DAY_MS),
          }),
        ];
      }

      return [
        makeOverviewRow("hidden-early", new Date(Date.now() + 4 * DAY_MS), {
          remindAt: new Date(Date.now() + DAY_MS),
        }),
        makeOverviewRow("hidden-late", new Date(Date.now() + 9 * DAY_MS), {
          remindAt: new Date(Date.now() + 2 * DAY_MS),
        }),
      ];
    },
  });

  const res = await app.inject({
    method: "GET",
    url: "/?status=active&view=overview&limit=3&soonWindowDays=7",
    headers: AUTH,
  });

  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(findManyCalls, 2);
  assert.equal(body.items.length, 3);
  assert.equal(body.items[0].id, "visible-1");
  assert.equal(body.items[1].id, "hidden-early");
  assert.equal(body.items[2].id, "hidden-late");
});

test("GET /: unauthenticated returns 401", async () => {
  const app = await buildApp();
  const res = await app.inject({ method: "GET", url: "/" });
  assert.equal(res.statusCode, 401);
});

// -- POST / ------------------------------------------------------------------

test("POST /: creates reminder and normalizes invalid timezone header to UTC", async () => {
  let createArgs: unknown;
  const dueAt = new Date(Date.now() + 10 * DAY_MS);

  const app = await buildApp({
    reminderCreate: async (args) => {
      createArgs = args;
      const data = (args as { data: ReminderRecord }).data;
      return makeReminderRecord({
        ...data,
        id: REMINDER_ID,
      });
    },
  });

  const res = await app.inject({
    method: "POST",
    url: "/",
    headers: { ...JSON_HEADERS, "x-timezone": "Not/A_Real_Timezone" },
    payload: JSON.stringify({
      title: "Pay rent",
      note: "Before noon",
      dueAt: dueAt.toISOString(),
      remindOffsetDays: 2,
      rrule: "FREQ=DAILY",
    }),
  });

  assert.equal(res.statusCode, 201);
  const body = res.json();
  assert.equal(body.reminder.id, REMINDER_ID);

  const data = (createArgs as { data: ReminderRecord }).data;
  assert.equal(data.title, "Pay rent");
  assert.equal(data.timezone, "UTC");
  assert.equal(data.rrule, "FREQ=DAILY");
  assert.equal(data.nextDueAt?.toISOString(), dueAt.toISOString());
  assert.equal(data.remindAt.toISOString(), new Date(dueAt.getTime() - 2 * DAY_MS).toISOString());
});

test("POST /: due datetime in the past returns 400", async () => {
  const app = await buildApp();
  const res = await app.inject({
    method: "POST",
    url: "/",
    headers: JSON_HEADERS,
    payload: JSON.stringify({
      title: "Past due",
      dueAt: new Date(Date.now() - DAY_MS).toISOString(),
    }),
  });

  assert.equal(res.statusCode, 400);
  assert.match(res.json().message, /due datetime must be in the future/i);
});

test("POST /: invalid rrule returns 400", async () => {
  const app = await buildApp();
  const res = await app.inject({
    method: "POST",
    url: "/",
    headers: JSON_HEADERS,
    payload: JSON.stringify({
      title: "Recurring",
      dueAt: new Date(Date.now() + DAY_MS).toISOString(),
      rrule: "FREQ=HOURLY",
    }),
  });

  assert.equal(res.statusCode, 400);
  assert.match(res.json().message, /unsupported rrule freq/i);
});

test("POST /: mediaId not owned by user returns 400", async () => {
  const app = await buildApp({
    mediaFindFirst: async () => null,
  });

  const res = await app.inject({
    method: "POST",
    url: "/",
    headers: JSON_HEADERS,
    payload: JSON.stringify({
      title: "Attach media",
      dueAt: new Date(Date.now() + DAY_MS).toISOString(),
      mediaId: MEDIA_ID,
    }),
  });

  assert.equal(res.statusCode, 400);
  assert.match(res.json().message, /mediaid does not belong to the authenticated user/i);
});

test("POST /: unauthenticated returns 401", async () => {
  const app = await buildApp();
  const res = await app.inject({
    method: "POST",
    url: "/",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({
      title: "No auth",
      dueAt: new Date(Date.now() + DAY_MS).toISOString(),
    }),
  });
  assert.equal(res.statusCode, 401);
});

// -- PATCH /:id --------------------------------------------------------------

test("PATCH /:id: returns 404 when reminder is missing", async () => {
  const app = await buildApp({
    reminderFindFirst: async () => null,
  });

  const res = await app.inject({
    method: "PATCH",
    url: `/${REMINDER_ID}`,
    headers: JSON_HEADERS,
    payload: JSON.stringify({ title: "Updated" }),
  });

  assert.equal(res.statusCode, 404);
});

test("PATCH /:id: empty payload currently returns 500 with validation message", async () => {
  const app = await buildApp();
  const res = await app.inject({
    method: "PATCH",
    url: `/${REMINDER_ID}`,
    headers: JSON_HEADERS,
    payload: JSON.stringify({}),
  });
  assert.equal(res.statusCode, 500);
  assert.match(res.json().message, /provide at least one field to update/i);
});

test("PATCH /:id: updates timing fields and recomputes remindAt/nextDueAt", async () => {
  let updateArgs: unknown;
  const nextDue = new Date(Date.now() + 12 * DAY_MS);
  const app = await buildApp({
    reminderFindFirst: async () => ({
      id: REMINDER_ID,
      dueAt: new Date(Date.now() + 20 * DAY_MS),
      nextDueAt: null,
      remindAt: new Date(Date.now() + 13 * DAY_MS),
      remindOffsetDays: 7,
      rrule: null,
    }),
    reminderUpdate: async (args) => {
      updateArgs = args;
      const data = (args as { data: Partial<ReminderRecord> }).data;
      return makeReminderRecord({
        id: REMINDER_ID,
        title: "Updated title",
        dueAt: data.dueAt ?? nextDue,
        remindOffsetDays: data.remindOffsetDays ?? null,
        remindAt: data.remindAt ?? new Date(nextDue.getTime() - 3 * DAY_MS),
        nextDueAt: data.nextDueAt ?? nextDue,
        rrule: data.rrule ?? "FREQ=DAILY",
      });
    },
  });

  const res = await app.inject({
    method: "PATCH",
    url: `/${REMINDER_ID}`,
    headers: JSON_HEADERS,
    payload: JSON.stringify({
      title: "Updated title",
      dueAt: nextDue.toISOString(),
      remindOffsetDays: 3,
      rrule: "FREQ=DAILY",
    }),
  });

  assert.equal(res.statusCode, 200);
  const data = (updateArgs as { data: Partial<ReminderRecord> }).data;
  assert.equal(data.rrule, "FREQ=DAILY");
  assert.equal(data.nextDueAt?.toISOString(), nextDue.toISOString());
  assert.equal(data.remindOffsetDays, 3);
  assert.equal(data.remindAt?.toISOString(), new Date(nextDue.getTime() - 3 * DAY_MS).toISOString());
});

test("PATCH /:id: mediaId ownership is enforced when mediaId is present", async () => {
  const app = await buildApp({
    reminderFindFirst: async () => ({
      id: REMINDER_ID,
      dueAt: new Date(Date.now() + 10 * DAY_MS),
      nextDueAt: null,
      remindAt: new Date(Date.now() + 3 * DAY_MS),
      remindOffsetDays: null,
      rrule: null,
    }),
    mediaFindFirst: async () => null,
  });

  const res = await app.inject({
    method: "PATCH",
    url: `/${REMINDER_ID}`,
    headers: JSON_HEADERS,
    payload: JSON.stringify({ mediaId: MEDIA_ID }),
  });

  assert.equal(res.statusCode, 400);
  assert.match(res.json().message, /mediaid does not belong to the authenticated user/i);
});

test("PATCH /:id: unauthenticated returns 401", async () => {
  const app = await buildApp();
  const res = await app.inject({
    method: "PATCH",
    url: `/${REMINDER_ID}`,
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ title: "No auth" }),
  });
  assert.equal(res.statusCode, 401);
});

// -- POST /:id/complete ------------------------------------------------------

test("POST /:id/complete: one-off reminder is marked completed", async () => {
  let updateArgs: unknown;
  const app = await buildApp({
    reminderFindFirst: async () => ({
      id: REMINDER_ID,
      status: "ACTIVE",
      dueAt: new Date(Date.now() + 5 * DAY_MS),
      nextDueAt: null,
      remindOffsetDays: null,
      rrule: null,
    }),
    reminderUpdate: async (args) => {
      updateArgs = args;
      return { ok: true };
    },
  });

  const res = await app.inject({
    method: "POST",
    url: `/${REMINDER_ID}/complete`,
    headers: AUTH,
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().ok, true);
  const data = (updateArgs as { data: { status: string; lastCompletedAt: Date } }).data;
  assert.equal(data.status, "COMPLETED");
  assert.ok(data.lastCompletedAt instanceof Date);
});

test("POST /:id/complete: recurring reminder advances nextDueAt and clears snooze", async () => {
  let updateArgs: unknown;
  const dueAt = new Date("2026-06-10T09:00:00.000Z");
  const app = await buildApp({
    reminderFindFirst: async () => ({
      id: REMINDER_ID,
      status: "ACTIVE",
      dueAt,
      nextDueAt: null,
      remindOffsetDays: 1,
      rrule: "FREQ=DAILY",
    }),
    reminderUpdate: async (args) => {
      updateArgs = args;
      return { ok: true };
    },
  });

  const res = await app.inject({
    method: "POST",
    url: `/${REMINDER_ID}/complete`,
    headers: AUTH,
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().ok, true);
  const data = (
    updateArgs as { data: { nextDueAt: Date; remindAt: Date; snoozedUntil: null; status: string } }
  ).data;
  assert.equal(data.status, "ACTIVE");
  assert.equal(data.nextDueAt.toISOString(), "2026-06-11T09:00:00.000Z");
  assert.equal(data.remindAt.toISOString(), "2026-06-10T09:00:00.000Z");
  assert.equal(data.snoozedUntil, null);
});

test("POST /:id/complete: non-active reminder returns 400", async () => {
  const app = await buildApp({
    reminderFindFirst: async () => ({
      id: REMINDER_ID,
      status: "COMPLETED",
      dueAt: new Date(Date.now() + DAY_MS),
      nextDueAt: null,
      remindOffsetDays: null,
      rrule: null,
    }),
  });

  const res = await app.inject({
    method: "POST",
    url: `/${REMINDER_ID}/complete`,
    headers: AUTH,
  });

  assert.equal(res.statusCode, 400);
  assert.match(res.json().message, /only active reminders can be completed/i);
});

test("POST /:id/complete: unauthenticated returns 401", async () => {
  const app = await buildApp();
  const res = await app.inject({
    method: "POST",
    url: `/${REMINDER_ID}/complete`,
  });
  assert.equal(res.statusCode, 401);
});

// -- POST /:id/snooze --------------------------------------------------------

test("POST /:id/snooze: sets snoozedUntil when active", async () => {
  let updateArgs: unknown;
  const until = new Date(Date.now() + 3 * DAY_MS);
  const app = await buildApp({
    reminderFindFirst: async () => ({ id: REMINDER_ID, status: "ACTIVE" }),
    reminderUpdate: async (args) => {
      updateArgs = args;
      return { ok: true };
    },
  });

  const res = await app.inject({
    method: "POST",
    url: `/${REMINDER_ID}/snooze`,
    headers: JSON_HEADERS,
    payload: JSON.stringify({ until: until.toISOString() }),
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().ok, true);
  const data = (updateArgs as { data: { snoozedUntil: Date } }).data;
  assert.equal(data.snoozedUntil.toISOString(), until.toISOString());
});

test("POST /:id/snooze: past until returns 400", async () => {
  const app = await buildApp();
  const res = await app.inject({
    method: "POST",
    url: `/${REMINDER_ID}/snooze`,
    headers: JSON_HEADERS,
    payload: JSON.stringify({ until: new Date(Date.now() - DAY_MS).toISOString() }),
  });

  assert.equal(res.statusCode, 400);
  assert.match(res.json().message, /snooze time must be in the future/i);
});

test("POST /:id/snooze: non-active reminder returns 400", async () => {
  const app = await buildApp({
    reminderFindFirst: async () => ({ id: REMINDER_ID, status: "COMPLETED" }),
  });

  const res = await app.inject({
    method: "POST",
    url: `/${REMINDER_ID}/snooze`,
    headers: JSON_HEADERS,
    payload: JSON.stringify({ until: new Date(Date.now() + DAY_MS).toISOString() }),
  });

  assert.equal(res.statusCode, 400);
  assert.match(res.json().message, /only active reminders can be snoozed/i);
});

test("POST /:id/snooze: unauthenticated returns 401", async () => {
  const app = await buildApp();
  const res = await app.inject({
    method: "POST",
    url: `/${REMINDER_ID}/snooze`,
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ until: new Date(Date.now() + DAY_MS).toISOString() }),
  });
  assert.equal(res.statusCode, 401);
});

// -- POST /:id/unsnooze ------------------------------------------------------

test("POST /:id/unsnooze: clears snooze when active", async () => {
  let updateArgs: unknown;
  const app = await buildApp({
    reminderFindFirst: async () => ({ id: REMINDER_ID, status: "ACTIVE" }),
    reminderUpdate: async (args) => {
      updateArgs = args;
      return { ok: true };
    },
  });

  const res = await app.inject({
    method: "POST",
    url: `/${REMINDER_ID}/unsnooze`,
    headers: AUTH,
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().ok, true);
  const data = (updateArgs as { data: { snoozedUntil: null } }).data;
  assert.equal(data.snoozedUntil, null);
});

test("POST /:id/unsnooze: non-active reminder returns 400", async () => {
  const app = await buildApp({
    reminderFindFirst: async () => ({ id: REMINDER_ID, status: "CANCELED" }),
  });

  const res = await app.inject({
    method: "POST",
    url: `/${REMINDER_ID}/unsnooze`,
    headers: AUTH,
  });

  assert.equal(res.statusCode, 400);
  assert.match(res.json().message, /only active reminders can be unsnoozed/i);
});

test("POST /:id/unsnooze: unauthenticated returns 401", async () => {
  const app = await buildApp();
  const res = await app.inject({
    method: "POST",
    url: `/${REMINDER_ID}/unsnooze`,
  });
  assert.equal(res.statusCode, 401);
});

// -- POST /:id/cancel --------------------------------------------------------

test("POST /:id/cancel: returns 404 when reminder is missing", async () => {
  const app = await buildApp({
    reminderFindFirst: async () => null,
  });

  const res = await app.inject({
    method: "POST",
    url: `/${REMINDER_ID}/cancel`,
    headers: AUTH,
  });

  assert.equal(res.statusCode, 404);
});

test("POST /:id/cancel: marks reminder canceled", async () => {
  let updateArgs: unknown;
  const app = await buildApp({
    reminderFindFirst: async () => ({ id: REMINDER_ID }),
    reminderUpdate: async (args) => {
      updateArgs = args;
      return { ok: true };
    },
  });

  const res = await app.inject({
    method: "POST",
    url: `/${REMINDER_ID}/cancel`,
    headers: AUTH,
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().ok, true);
  const data = (updateArgs as { data: { status: string } }).data;
  assert.equal(data.status, "CANCELED");
});

test("POST /:id/cancel: unauthenticated returns 401", async () => {
  const app = await buildApp();
  const res = await app.inject({
    method: "POST",
    url: `/${REMINDER_ID}/cancel`,
  });
  assert.equal(res.statusCode, 401);
});
