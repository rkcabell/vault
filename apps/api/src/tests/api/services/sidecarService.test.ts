import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { createSidecarService, type SidecarServiceDeps } from "@/services/sidecar/sidecarService.js";
import type {
  RestorePatch,
  RestoreTargetRow,
  SnapshotSourceRow,
} from "@/repositories/sidecarRepository.js";
import { parseHeader, parseLine } from "@/lib/sidecar/snapshotFormat.js";
import type { RestoreStore } from "@/lib/sidecar/restoreState.js";
import type { SidecarRestoreState } from "@vault/types";

const logger = { info: () => {}, warn: () => {}, error: () => {} };
const BUCKET = "vault-media";

/** In-memory StorageAdapter — only the three methods this service touches. */
function makeStorage () {
  const objects = new Map<string, string>();
  return {
    objects,
    adapter: {
      putObject: async ({ key, body }: { key: string; body: Readable | Buffer }) => {
        const chunks: Buffer[] = [];
        for await (const chunk of body as Readable) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        }
        objects.set(key, Buffer.concat(chunks).toString("utf8"));
      },
      getObjectStream: async ({ key }: { key: string }) => {
        const body = objects.get(key);
        if (body === undefined) return null;
        const stream = Readable.from([body]);
        return { body: stream, etag: null, contentLength: Buffer.byteLength(body) };
      },
    },
  } as unknown as { objects: Map<string, string>; adapter: SidecarServiceDeps["storage"] };
}

function row (over: Partial<SnapshotSourceRow> & { id: string }): SnapshotSourceRow {
  return {
    sourcePath: `E:/data/${over.id}.pdf`,
    filename: `${over.id}.pdf`,
    mimeType: "application/pdf",
    sizeBytes: 100,
    contentHash: null,
    title: over.id,
    titleIsUserEdited: false,
    tags: [],
    starred: false,
    starredAt: null,
    fileDate: null,
    bundles: [],
    reminders: [],
    ...over,
  };
}

function target (over: Partial<RestoreTargetRow> & { id: string }): RestoreTargetRow {
  return {
    sourcePath: `E:/data/${over.id}.pdf`,
    contentHash: null,
    title: over.id,
    titleIsUserEdited: false,
    tags: [],
    starred: false,
    fileDate: null,
    bundles: [],
    reminderCount: 0,
    ...over,
  };
}

type RepoOverrides = {
  rows?: SnapshotSourceRow[];
  targets?: RestoreTargetRow[];
  tags?: Array<{ name: string; color: string | null; origin: "USER" | "AUTO" }>;
  probe?: () => Promise<{ key: string; mediaCount: number }>;
};

function makeRepo (over: RepoOverrides = {}) {
  const rows = over.rows ?? [];
  const applied: RestorePatch[] = [];
  const bundleItems: Array<{ bundleId: string; mediaId: string }> = [];
  const createdReminders: Array<{ mediaId: string; title: string }> = [];
  const restoredVocabulary: Array<{ name: string }> = [];
  let probeCalls = 0;

  const repository = {
    changeProbe: over.probe ?? (async () => {
      probeCalls += 1;
      return { key: "probe-1", mediaCount: rows.length };
    }),
    listTags: async () => over.tags ?? [],
    listExportPage: async (_userId: string, afterId: string | null, limit: number) => {
      const start = afterId ? rows.findIndex(r => r.id === afterId) + 1 : 0;
      return rows.slice(start, start + limit);
    },
    findRestoreTargets: async (_userId: string, sourcePaths: string[], contentHashes: string[]) =>
      (over.targets ?? []).filter(t =>
        (t.sourcePath && sourcePaths.includes(t.sourcePath))
        || (t.contentHash && contentHashes.includes(t.contentHash))),
    applyRestorePatches: async (patches: RestorePatch[]) => {
      applied.push(...patches);
      return patches.length;
    },
    ensureBundles: async (_userId: string, names: string[]) =>
      new Map(names.map(name => [name, `bundle-${name}`])),
    addBundleItems: async (items: Array<{ bundleId: string; mediaId: string }>) => {
      bundleItems.push(...items);
      return items.length;
    },
    createReminders: async (_userId: string, reminders: Array<{ mediaId: string; title: string }>) => {
      createdReminders.push(...reminders);
      return reminders.length;
    },
    restoreTagVocabulary: async (_userId: string, tags: Array<{ name: string }>) => {
      restoredVocabulary.push(...tags);
      return tags.length;
    },
  } as unknown as SidecarServiceDeps["repository"];

  return { repository, applied, bundleItems, createdReminders, restoredVocabulary, probeCalls: () => probeCalls };
}

/** In-memory stand-in for the Redis store, keeping the same state/lock split so
 *  an interrupted run can be simulated. */
function makeRestoreStore () {
  let state: SidecarRestoreState | null = null;
  let lock: string | null = null;

  const store: RestoreStore = {
    acquire: async (_userId, next) => {
      if (lock !== null) return false;
      lock = next.startedAt;
      state = next;
      return true;
    },
    heartbeat: async (_userId, next) => { state = next; },
    finish: async (_userId, next) => { state = next; lock = null; },
    read: async () => {
      const current = state;
      if (current?.state !== "running") return current;
      return lock !== null
        ? current
        : { state: "interrupted", startedAt: current.startedAt, processed: current.processed };
    },
    isRunning: async () => lock !== null,
  };

  return {
    store,
    /** What a process killed mid-restore leaves once its lock TTL lapses. */
    expireLock: () => { lock = null; },
  };
}

function makeService (over: RepoOverrides & { mode?: "off" | "snapshot"; intervalMinutes?: number } = {}) {
  const storage = makeStorage();
  const repo = makeRepo(over);
  const restoreStore = makeRestoreStore();
  let reconciled = 0;
  const service = createSidecarService({
    repository: repo.repository,
    storage: storage.adapter,
    bucket: BUCKET,
    logger,
    getMode: async () => over.mode ?? "snapshot",
    getIntervalMinutes: async () => over.intervalMinutes ?? 5,
    listUserIds: async () => ["u1"],
    reconcileTagCounts: async () => { reconciled += 1; },
    restoreStore: restoreStore.store,
  });
  return { service, storage, repo, restoreStore, reconciled: () => reconciled };
}

const KEY = "sidecars/u1/library-snapshot.jsonl";

function linesOf (storage: { objects: Map<string, string> }, key = KEY): string[] {
  return (storage.objects.get(key) ?? "").split("\n").filter(Boolean);
}

test("export writes a header, the tag vocabulary, then one line per item", async () => {
  const { service, storage } = makeService({
    rows: [row({ id: "m1", tags: ["invoice"] }), row({ id: "m2" })],
    tags: [{ name: "invoice", color: "#ff0000", origin: "USER" }],
  });

  const result = await service.exportSnapshot("u1");
  assert.equal(result?.entries, 2);

  const lines = linesOf(storage);
  assert.equal(lines.length, 4);
  assert.equal(parseHeader(lines[0]!).userId, "u1");
  assert.equal(parseLine(lines[1]!).type, "tags");
  assert.equal(parseLine(lines[2]!).type, "entry");
  assert.equal(parseLine(lines[3]!).type, "entry");
});

test("a row with neither match key is not written — nothing could reattach it", async () => {
  const { service, storage } = makeService({
    rows: [row({ id: "m1" }), row({ id: "m2", sourcePath: null, contentHash: null })],
  });

  const result = await service.exportSnapshot("u1");
  assert.equal(result?.entries, 1);
  assert.equal(linesOf(storage).length, 3);
});

test("mode off writes nothing at all", async () => {
  const { service, storage } = makeService({ rows: [row({ id: "m1" })], mode: "off" });
  assert.equal(await service.exportSnapshot("u1"), null);
  assert.equal(storage.objects.size, 0);
});

test("an unchanged library is not rewritten, but force overrides the probe", async () => {
  const { service } = makeService({ rows: [row({ id: "m1" })] });

  assert.notEqual(await service.exportSnapshot("u1"), null);
  assert.equal(await service.exportSnapshot("u1"), null, "second export skipped by the change probe");
  assert.notEqual(await service.exportSnapshot("u1", { force: true }), null, "force ignores the probe");
});

test("a failed write does not mark the database as snapshotted", async () => {
  const { service, storage } = makeService({ rows: [row({ id: "m1" })] });
  const original = storage.adapter.putObject;
  let fail = true;
  (storage.adapter as { putObject: unknown }).putObject = async (input: Parameters<typeof original>[0]) => {
    if (fail) throw new Error("disk full");
    return original(input);
  };

  await assert.rejects(() => service.exportSnapshot("u1"), /disk full/);
  fail = false;
  // The retry must write rather than skip on a probe recorded by the
  // failed attempt.
  assert.notEqual(await service.exportSnapshot("u1"), null);
});

test("the previous snapshot is rotated to .bak before being overwritten", async () => {
  const { service, storage, repo } = makeService({ rows: [row({ id: "m1" })] });
  await service.exportSnapshot("u1");
  const first = storage.objects.get(KEY);

  (repo.repository as unknown as { changeProbe: () => Promise<unknown> }).changeProbe =
    async () => ({ key: "probe-2", mediaCount: 1 });
  await service.exportSnapshot("u1");

  assert.equal(storage.objects.get(`${KEY}.bak`), first);
});

test("restore fills gaps and leaves everything the library already knows alone", async () => {
  const exported = makeService({
    rows: [row({
      id: "m1",
      tags: ["invoice", "paid"],
      title: "Acme invoice",
      titleIsUserEdited: true,
      starred: true,
      starredAt: new Date("2026-03-02T11:04:00Z"),
      fileDate: new Date("2024-11-08T00:00:00Z"),
    })],
  });
  await exported.service.exportSnapshot("u1");

  // The live row already carries a newer title the user typed, one of the two
  // tags, and its own fileDate.
  const restored = makeService({
    targets: [target({
      id: "m1",
      tags: ["paid"],
      title: "Renamed since",
      titleIsUserEdited: true,
      fileDate: new Date("2025-01-01T00:00:00Z"),
    })],
  });
  restored.storage.objects.set(KEY, exported.storage.objects.get(KEY)!);

  const result = await restored.service.restore("u1");
  assert.equal(result.matched, 1);
  assert.equal(result.updated, 1);

  const patch = restored.repo.applied[0]!;
  assert.deepEqual(patch.tags, ["paid", "invoice"], "missing tag appended, existing one not duplicated");
  assert.equal(patch.title, undefined, "a title the user already edited is never overwritten");
  assert.equal(patch.starred, true);
  assert.equal(patch.fileDate, undefined, "a live fileDate wins over the snapshot's");
});

test("a title the user never edited is not restored — a rescan re-derives it", async () => {
  const exported = makeService({
    rows: [row({ id: "m1", title: "m1", titleIsUserEdited: false })],
  });
  await exported.service.exportSnapshot("u1");

  const restored = makeService({ targets: [target({ id: "m1" })] });
  restored.storage.objects.set(KEY, exported.storage.objects.get(KEY)!);

  const result = await restored.service.restore("u1");
  assert.equal(result.matched, 1);
  assert.equal(result.updated, 0, "nothing to put back, so no write at all");
});

test("restore is idempotent — a second pass finds nothing left to do", async () => {
  const exported = makeService({ rows: [row({ id: "m1", tags: ["invoice"] })] });
  await exported.service.exportSnapshot("u1");

  const restored = makeService({ targets: [target({ id: "m1", tags: ["invoice"] })] });
  restored.storage.objects.set(KEY, exported.storage.objects.get(KEY)!);

  const first = await restored.service.restore("u1");
  const second = await restored.service.restore("u1");
  assert.equal(first.updated, 0);
  assert.equal(second.updated, 0);
  assert.equal(restored.repo.applied.length, 0);
});

test("a path that moved is rematched on contentHash", async () => {
  const exported = makeService({
    rows: [row({ id: "m1", sourcePath: "E:/old/a.pdf", contentHash: "sha256:aaa", tags: ["invoice"] })],
  });
  await exported.service.exportSnapshot("u1");

  const restored = makeService({
    targets: [target({ id: "new-id", sourcePath: "E:/new/a.pdf", contentHash: "sha256:aaa" })],
  });
  restored.storage.objects.set(KEY, exported.storage.objects.get(KEY)!);

  const result = await restored.service.restore("u1");
  assert.equal(result.matched, 1);
  assert.deepEqual(restored.repo.applied[0]!.tags, ["invoice"]);
});

test("an ambiguous hash matches nothing — duplicates must not both get one item's tags", async () => {
  const exported = makeService({
    rows: [row({ id: "m1", sourcePath: "E:/old/a.pdf", contentHash: "sha256:aaa", tags: ["invoice"] })],
  });
  await exported.service.exportSnapshot("u1");

  const restored = makeService({
    targets: [
      target({ id: "copy-1", sourcePath: "E:/new/a.pdf", contentHash: "sha256:aaa" }),
      target({ id: "copy-2", sourcePath: "E:/backup/a.pdf", contentHash: "sha256:aaa" }),
    ],
  });
  restored.storage.objects.set(KEY, exported.storage.objects.get(KEY)!);

  const result = await restored.service.restore("u1");
  assert.equal(result.matched, 0);
  assert.equal(restored.repo.applied.length, 0);
});

test("bundle membership comes back by name, and an existing membership is not re-added", async () => {
  const exported = makeService({
    rows: [
      row({ id: "m1", bundles: ["Taxes 2024"] }),
      row({ id: "m2", bundles: ["Taxes 2024"] }),
    ],
  });
  await exported.service.exportSnapshot("u1");

  const restored = makeService({
    targets: [
      target({ id: "m1" }),
      target({ id: "m2", bundles: ["Taxes 2024"] }),
    ],
  });
  restored.storage.objects.set(KEY, exported.storage.objects.get(KEY)!);

  const result = await restored.service.restore("u1");
  assert.equal(result.bundlesRestored, 1);
  assert.deepEqual(restored.repo.bundleItems, [{ bundleId: "bundle-Taxes 2024", mediaId: "m1" }]);
});

test("reminders are recreated only for a row that has none", async () => {
  const reminder = {
    title: "Pay",
    note: null,
    dueAt: new Date("2026-08-01T09:00:00Z"),
    remindAt: new Date("2026-07-30T09:00:00Z"),
    timezone: "UTC",
    rrule: null,
    remindOffsetDays: null,
  };
  const exported = makeService({
    rows: [row({ id: "m1", reminders: [reminder] }), row({ id: "m2", reminders: [reminder] })],
  });
  await exported.service.exportSnapshot("u1");

  const restored = makeService({
    targets: [target({ id: "m1" }), target({ id: "m2", reminderCount: 3 })],
  });
  restored.storage.objects.set(KEY, exported.storage.objects.get(KEY)!);

  const result = await restored.service.restore("u1");
  assert.equal(result.remindersRestored, 1);
  assert.deepEqual(restored.repo.createdReminders.map(r => r.mediaId), ["m1"]);
});

test("restore rebuilds tag colours and recomputes tag counts", async () => {
  const exported = makeService({
    rows: [row({ id: "m1", tags: ["invoice"] })],
    tags: [{ name: "invoice", color: "#ff0000", origin: "USER" }],
  });
  await exported.service.exportSnapshot("u1");

  const restored = makeService({ targets: [target({ id: "m1" })] });
  restored.storage.objects.set(KEY, exported.storage.objects.get(KEY)!);

  const result = await restored.service.restore("u1");
  assert.equal(result.tagVocabularyRestored, 1);
  assert.deepEqual(restored.repo.restoredVocabulary.map(t => t.name), ["invoice"]);
  assert.equal(restored.reconciled(), 1, "Media.tags was rewritten, so Tag.count must be recomputed");
});

test("restore with no snapshot on disk fails loudly", async () => {
  const { service } = makeService();
  await assert.rejects(() => service.restore("u1"), /No snapshot/);
});

test("a restore in flight blocks a second one", async () => {
  const exported = makeService({ rows: [row({ id: "m1" })] });
  await exported.service.exportSnapshot("u1");

  const restored = makeService({ targets: [target({ id: "m1" })] });
  restored.storage.objects.set(KEY, exported.storage.objects.get(KEY)!);

  assert.deepEqual(await restored.service.startRestore("u1"), { started: true });
  assert.deepEqual(await restored.service.startRestore("u1"), { started: false });
});

test("a restore the process never finished reports as interrupted, not as none at all", async () => {
  const exported = makeService({ rows: [row({ id: "m1" })] });
  await exported.service.exportSnapshot("u1");

  const live = makeService({ targets: [target({ id: "m1" })] });
  live.storage.objects.set(KEY, exported.storage.objects.get(KEY)!);

  // A restart mid-restore: the running state outlives the lock that backed it.
  await live.restoreStore.store.acquire("u1", {
    state: "running",
    startedAt: "2026-07-30T10:00:00.000Z",
    processed: 40,
  });
  live.restoreStore.expireLock();

  const status = await live.service.getStatus("u1");
  assert.deepEqual(status.restore, {
    state: "interrupted",
    startedAt: "2026-07-30T10:00:00.000Z",
    processed: 40,
  });
});

test("a lapsed lock frees both the re-run and the export loop", async () => {
  const exported = makeService({ rows: [row({ id: "m1" })] });
  await exported.service.exportSnapshot("u1");

  const live = makeService({ rows: [row({ id: "m1" })], targets: [target({ id: "m1" })] });
  live.storage.objects.set(KEY, exported.storage.objects.get(KEY)!);
  await live.restoreStore.store.acquire("u1", {
    state: "running",
    startedAt: "2026-07-30T10:00:00.000Z",
    processed: 40,
  });

  // An export rotates the previous file to .bak, so .bak appearing is the tell
  // that the loop ran for this user.
  await live.service.tick();
  assert.equal(live.storage.objects.has(`${KEY}.bak`), false, "a held lock keeps the export off");

  live.restoreStore.expireLock();
  await live.service.tick();
  assert.equal(live.storage.objects.has(`${KEY}.bak`), true, "a lapsed lock lets exports resume");

  assert.deepEqual(await live.service.startRestore("u1"), { started: true }, "and lets a re-run start");
});

test("status reads the header only, and reports a restore result once it lands", async () => {
  const exported = makeService({ rows: [row({ id: "m1" }), row({ id: "m2" })] });
  await exported.service.exportSnapshot("u1");

  const restored = makeService({ targets: [target({ id: "m1" })] });
  restored.storage.objects.set(KEY, exported.storage.objects.get(KEY)!);

  const before = await restored.service.getStatus("u1");
  assert.equal(before.snapshot?.entries, 2);
  assert.equal(before.restore, null);
  // A live service always reports enabled; the false case is the route's
  // fallback when the plugin never constructed one.
  assert.equal(before.enabled, true);

  await restored.service.restore("u1");
  await restored.service.startRestore("u1");
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));

  const after = await restored.service.getStatus("u1");
  assert.ok(after.restore, "a finished restore is reported back");
});

test("the export loop skips a user whose restore is still running", async () => {
  const exported = makeService({ rows: [row({ id: "m1" })] });
  await exported.service.exportSnapshot("u1");

  const live = makeService({ rows: [row({ id: "m1" })], targets: [target({ id: "m1" })] });
  live.storage.objects.set(KEY, exported.storage.objects.get(KEY)!);
  const snapshotBefore = live.storage.objects.get(KEY);

  await live.service.startRestore("u1");
  await live.service.tick();

  // Exporting mid-restore would overwrite the file being read with a
  // half-restored library.
  assert.equal(live.storage.objects.get(KEY), snapshotBefore);
});
