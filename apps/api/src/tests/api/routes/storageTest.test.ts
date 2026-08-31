// Regression tests for POST /storage/test.
//
// This endpoint previously crashed the entire API: it opened a read stream on
// the health-check object, destroyed it, then deleted the file — and the fs
// adapter's async createReadStream emitted an unhandled 'error' (ENOENT) that
// took the process down. These tests pin the round-trip to a real filesystem
// adapter and assert it returns cleanly and never leaves the artifact behind.

import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import sensible from "@fastify/sensible";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { serverRoutes } from "@/routes/server.js";
import { createFsAdapter } from "@/adapters/storage/fsAdapter.js";
import type { StorageAdapter } from "@/adapters/storage/types.js";

const AUTH = { authorization: "Bearer test-token" };

async function buildApp(storage: StorageAdapter, driver = "fs") {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  (app as unknown as { decorate: (k: string, v: unknown) => void }).decorate("jwt", {
    verifyAccess: () => ({ sub: "user-1" }),
  });
  (app as unknown as { decorate: (k: string, v: unknown) => void }).decorate("config", {
    STORAGE_BUCKET: "vault-media",
    STORAGE_DRIVER: driver,
    NODE_ENV: "test",
  });
  (app as unknown as { decorate: (k: string, v: unknown) => void }).decorate("storage", storage);
  // /fs/list and /fs/mkdir attach a limiter at registration time; no-op here.
  (app as unknown as { decorate: (k: string, v: unknown) => void }).decorate("userRateLimit", () => async () => {});
  await app.register(serverRoutes);
  return app;
}

test("POST /storage/test: fs round-trip returns ok and cleans up (no crash)", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "vault-storagetest-"));
  const app = await buildApp(createFsAdapter({ basePath: base }));
  try {
    const res = await app.inject({ method: "POST", url: "/storage/test", headers: AUTH });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true);
    assert.equal(body.driver, "fs");
    assert.equal(typeof body.durationMs, "number");

    // The probe file must be deleted. Flat key means no subdirectory was created,
    // so we just check the storage root has no _healthcheck-* files left.
    const leftovers = (await readdir(base)).filter(f => f.startsWith("_healthcheck-"));
    assert.equal(leftovers.length, 0, "health-check artifact should be cleaned up");
  } finally {
    await app.close();
    await rm(base, { recursive: true, force: true });
  }
});

test("POST /storage/test: returns 503 (not a crash) when readback fails", async () => {
  // putObject "succeeds" but the object can't be read back — must degrade to 503.
  const flaky: StorageAdapter = {
    presignPut: async () => "",
    presignGet: async () => "",
    getObjectStream: async () => null,
    putObject: async () => {},
    deleteIfPresent: async () => {},
    objectExists: async () => false,
    usage: async () => ({ sizeBytes: 0, objectCount: 0 }),
  };
  const app = await buildApp(flaky);
  try {
    const res = await app.inject({ method: "POST", url: "/storage/test", headers: AUTH });
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().ok, false);
  } finally {
    await app.close();
  }
});

test("POST /storage/test: unauthenticated returns 401", async () => {
  let touched = false;
  const guard: StorageAdapter = {
    presignPut: async () => { touched = true; return ""; },
    presignGet: async () => { touched = true; return ""; },
    getObjectStream: async () => { touched = true; return null; },
    putObject: async () => { touched = true; },
    deleteIfPresent: async () => { touched = true; },
    objectExists: async () => { touched = true; return false; },
    usage: async () => { touched = true; return { sizeBytes: 0, objectCount: 0 }; },
  };
  const app = await buildApp(guard);
  try {
    const res = await app.inject({ method: "POST", url: "/storage/test" });
    assert.equal(res.statusCode, 401);
    assert.equal(touched, false, "storage must not be touched when unauthenticated");
  } finally {
    await app.close();
  }
});
