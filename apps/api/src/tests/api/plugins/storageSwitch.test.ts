// Stability tests for switching the storage backend (fs <-> s3).
//
// Two failure surfaces are covered:
//   1. BOOT — env validation must accept a complete config for each driver and
//      FAIL LOUDLY (throw at startup) on an incomplete switch, rather than
//      booting into a half-configured state. This is the classic "I set
//      STORAGE_DRIVER=s3 but left the S3_* vars commented out, and it won't
//      boot" trap.
//   2. RUNTIME — after a switch, objects uploaded to the *other* backend are
//      absent in the now-active one. Reads of a missing object must resolve to
//      null (never throw), so orphaned files degrade gracefully instead of
//      crashing the app.
//
// No real S3/Postgres/Redis — config is exercised via the real configPlugin and
// the adapters via a temp dir / a fake S3 client.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { S3Client } from "@aws-sdk/client-s3";
import Fastify from "fastify";
import { configPlugin } from "@/plugins/config.js";
import { createFsAdapter } from "@/adapters/storage/fsAdapter.js";
import { createS3Adapter } from "@/adapters/s3Adapter.js";
import { streamToBuffer } from "@/lib/streams/toBuffer.js";

// ── config (boot) harness ─────────────────────────────────────────────────────

// Non-storage vars required by the schema; kept constant across scenarios.
const BASE: Record<string, string> = {
  NODE_ENV: "test",
  JWT_SECRET: "x".repeat(32),
  JWT_REFRESH_SECRET: "y".repeat(32),
  REDIS_URL: "redis://localhost:6379",
};

const FULL_S3: Record<string, string> = {
  S3_ENDPOINT: "http://localhost:9000",
  S3_PUBLIC_ENDPOINT: "http://localhost:9000",
  S3_ACCESS_KEY_ID: "vault",
  S3_SECRET_ACCESS_KEY: "vaultvault",
  S3_BUCKET: "vault-media",
};

// Every env key these tests touch — snapshotted and restored around each run so
// scenarios can't leak into each other or the rest of the process.
const TOUCHED = [
  "STORAGE_DRIVER", "STORAGE_FS_PATH",
  "S3_ENDPOINT", "S3_PUBLIC_ENDPOINT", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY",
  "S3_BUCKET", "S3_REGION",
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

test("boot: fs mode with a path is valid", async () => {
  const cfg = await loadConfig({ STORAGE_DRIVER: "fs", STORAGE_FS_PATH: "/data/vault" });
  assert.equal(cfg.STORAGE_DRIVER, "fs");
  assert.equal(cfg.STORAGE_FS_PATH, "/data/vault");
});

test("boot: fs mode without an explicit path uses the default and is valid", async () => {
  const cfg = await loadConfig({ STORAGE_DRIVER: "fs" });
  assert.equal(cfg.STORAGE_DRIVER, "fs");
  assert.equal(cfg.STORAGE_FS_PATH, "/data/vault");
});

test("boot: fs mode with an explicitly empty path fails fast", async () => {
  await assert.rejects(
    loadConfig({ STORAGE_DRIVER: "fs", STORAGE_FS_PATH: "" }),
    /Invalid environment configuration/,
  );
});

test("boot: s3 mode with full S3 config is valid", async () => {
  const cfg = await loadConfig({ STORAGE_DRIVER: "s3", ...FULL_S3 });
  assert.equal(cfg.STORAGE_DRIVER, "s3");
});

test("boot: switching to s3 with the S3_* vars missing fails fast (the commented-out trap)", async () => {
  // Exactly the manual scenario: flip the driver to s3 but leave S3 settings out.
  await assert.rejects(
    loadConfig({ STORAGE_DRIVER: "s3", STORAGE_FS_PATH: "/data/vault" }),
    /Invalid environment configuration/,
  );
});

test("boot: default driver is fs and boots zero-config when STORAGE_DRIVER is unset", async () => {
  const cfg = await loadConfig({}); // nothing storage-related
  assert.equal(cfg.STORAGE_DRIVER, "fs");
  assert.equal(cfg.STORAGE_FS_PATH, "/data/vault");
});

test("boot: leftover opposite-mode vars do not break either driver", async () => {
  // Messy real env files keep BOTH blocks; the active driver must still win.
  const asFs = await loadConfig({ STORAGE_DRIVER: "fs", STORAGE_FS_PATH: "/data/vault", ...FULL_S3 });
  assert.equal(asFs.STORAGE_DRIVER, "fs");

  const asS3 = await loadConfig({ STORAGE_DRIVER: "s3", STORAGE_FS_PATH: "/data/vault", ...FULL_S3 });
  assert.equal(asS3.STORAGE_DRIVER, "s3");
});

// ── runtime (post-switch) adapter behavior ────────────────────────────────────

test("runtime: fs adapter reads a missing (orphaned) object as null, and a fresh write round-trips", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "vault-switch-"));
  try {
    const fs = createFsAdapter({ basePath: base });

    // An object that was uploaded to the *other* backend is simply absent here —
    // must be null, not an exception.
    assert.equal(await fs.getObjectStream({ bucket: "b", key: "user-1/old/file.pdf" }), null);
    assert.equal(await fs.objectExists({ bucket: "b", key: "user-1/old/file.pdf" }), false);

    // The newly active backend still works for new uploads.
    await fs.putObject({ bucket: "b", key: "user-1/new/file.txt", body: Buffer.from("hi"), contentType: "text/plain" });
    const res = await fs.getObjectStream({ bucket: "b", key: "user-1/new/file.txt" });
    assert.ok(res);
    assert.equal((await streamToBuffer(res!.body)).toString(), "hi");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("runtime: s3 adapter reads a missing (orphaned) object as null", async () => {
  // Fake an S3 backend that 404s every request (object not present in this backend).
  const notFound = Object.assign(new Error("not found"), {
    name: "NoSuchKey",
    $metadata: { httpStatusCode: 404 },
  });
  const fakeS3 = { send: async () => { throw notFound; } } as unknown as S3Client;
  const s3 = createS3Adapter(fakeS3);

  assert.equal(await s3.getObjectStream({ bucket: "b", key: "user-1/old/file.pdf" }), null);
  assert.equal(await s3.objectExists({ bucket: "b", key: "user-1/old/file.pdf" }), false);
});

test("runtime: s3 adapter surfaces non-404 errors instead of masking them as missing", async () => {
  // A real outage (e.g. wrong endpoint) must NOT look like "object absent" — it
  // should throw so callers/retries can react, not silently return null.
  const boom = Object.assign(new Error("connection reset"), {
    name: "ECONNRESET",
    $metadata: { httpStatusCode: 500 },
  });
  const fakeS3 = { send: async () => { throw boom; } } as unknown as S3Client;
  const s3 = createS3Adapter(fakeS3);

  await assert.rejects(() => s3.getObjectStream({ bucket: "b", key: "k" }));
  await assert.rejects(() => s3.objectExists({ bucket: "b", key: "k" }));
});
