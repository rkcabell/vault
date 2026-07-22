// Stability tests for the storage configuration and filesystem adapter.
//
// Two failure surfaces are covered:
//   1. BOOT — env validation must accept a complete config, default sensibly
//      when STORAGE_FS_PATH is unset, and FAIL LOUDLY on an explicitly empty
//      path rather than booting into a half-configured state.
//   2. RUNTIME — reads of a missing object must resolve to null (never throw),
//      so orphaned records degrade gracefully instead of crashing the app.
//
// No real Postgres/Redis — config is exercised via the real configPlugin and
// the adapter via a temp dir.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { configPlugin } from "@/plugins/config.js";
import { createFsAdapter } from "@/adapters/storage/fsAdapter.js";
import { streamToBuffer } from "@/lib/streams/toBuffer.js";

// ── config (boot) harness ─────────────────────────────────────────────────────

// Non-storage vars required by the schema; kept constant across scenarios.
const BASE: Record<string, string> = {
  NODE_ENV: "test",
  JWT_SECRET: "x".repeat(32),
  JWT_REFRESH_SECRET: "y".repeat(32),
  REDIS_URL: "redis://localhost:6379",
};

// Every env key these tests touch — snapshotted and restored around each run so
// scenarios can't leak into each other or the rest of the process.
const TOUCHED = [
  "STORAGE_FS_PATH", "STORAGE_BUCKET",
  "NODE_ENV", "JWT_SECRET", "JWT_REFRESH_SECRET", "REDIS_URL", "POSTGRES_URL",
  "CORS_ORIGIN", "HOST", "PORT",
];

/** Parse env through the real configPlugin. Resolves to app.config or throws on invalid config. */
async function loadConfig(overrides: Record<string, string | undefined>) {
  const saved: Record<string, string | undefined> = {};
  for (const k of TOUCHED) saved[k] = process.env[k];
  try {
    for (const k of TOUCHED) delete process.env[k];
    Object.assign(process.env, BASE);
    for (const [k, v] of Object.entries(overrides)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    const app = Fastify({ logger: false });
    app.register(configPlugin);
    try {
      await app.ready(); // executes the plugin; rejects if env is invalid
      return app.config;
    } finally {
      await app.close();
    }
  } finally {
    for (const k of TOUCHED) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test("boot: an explicit storage path is accepted", async () => {
  const cfg = await loadConfig({ STORAGE_FS_PATH: "/data/vault" });
  assert.equal(cfg.STORAGE_FS_PATH, "/data/vault");
});

test("boot: zero-config uses the default path and bucket namespace", async () => {
  const cfg = await loadConfig({});
  assert.equal(cfg.STORAGE_FS_PATH, "/data/vault");
  assert.equal(cfg.STORAGE_BUCKET, "vault-media");
});

test("boot: an explicitly empty storage path fails fast", async () => {
  await assert.rejects(
    loadConfig({ STORAGE_FS_PATH: "" }),
    /Invalid environment configuration/,
  );
});

// ── runtime adapter behavior ──────────────────────────────────────────────────

test("runtime: fs adapter reads a missing (orphaned) object as null, and a fresh write round-trips", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "vault-switch-"));
  try {
    const fs = createFsAdapter({ basePath: base });

    // A record pointing at an object that no longer exists is simply absent —
    // must be null, not an exception.
    assert.equal(await fs.getObjectStream({ bucket: "b", key: "user-1/old/file.pdf" }), null);
    assert.equal(await fs.objectExists({ bucket: "b", key: "user-1/old/file.pdf" }), false);

    // New uploads round-trip.
    await fs.putObject({ bucket: "b", key: "user-1/new/file.txt", body: Buffer.from("hi"), contentType: "text/plain" });
    const res = await fs.getObjectStream({ bucket: "b", key: "user-1/new/file.txt" });
    assert.ok(res);
    assert.equal((await streamToBuffer(res!.body)).toString(), "hi");
    assert.equal(res!.totalLength, 2);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("runtime: fs adapter honors byte ranges", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "vault-range-"));
  try {
    const fs = createFsAdapter({ basePath: base });
    await fs.putObject({ bucket: "b", key: "user-1/x/abc.txt", body: Buffer.from("0123456789"), contentType: "text/plain" });

    const mid = await fs.getObjectStream({ bucket: "b", key: "user-1/x/abc.txt", range: { start: 2, end: 5 } });
    assert.ok(mid);
    assert.equal((await streamToBuffer(mid!.body)).toString(), "2345");
    assert.equal(mid!.contentLength, 4);
    assert.equal(mid!.totalLength, 10);

    // End past EOF is clamped, not an error.
    const tail = await fs.getObjectStream({ bucket: "b", key: "user-1/x/abc.txt", range: { start: 8, end: 99 } });
    assert.ok(tail);
    assert.equal((await streamToBuffer(tail!.body)).toString(), "89");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
