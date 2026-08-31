import test from "node:test";
import assert from "node:assert/strict";
import { PreferencesService } from "@/services/preferencesService.js";
import type { PreferencesRepository } from "@/repositories/preferencesRepository.js";

/** Service over a fixed stored blob — the shape a pre-rename row still has. */
function makeService (stored: unknown) {
  const repo = {
    getPreferences: async () => stored,
    listAll: async () => [{ id: "u1", preferences: stored }],
    updatePreferences: async () => stored,
  } as unknown as PreferencesRepository;
  return new PreferencesService(repo);
}

test("getPreferences: maps the pre-rename autoTagOnUpload key forward", async () => {
  const prefs = await makeService({ autoTagOnUpload: false }).getPreferences("u1");

  // Without the forward map this silently reads as the `true` default, i.e. the
  // user's "don't auto-tag my files" setting quietly turns itself back on.
  assert.equal(prefs.autoTagOnIngest, false);
  assert.ok(!("autoTagOnUpload" in prefs), "the legacy key does not survive the merge");
});

test("getPreferences: the current key wins when a blob carries both", async () => {
  const prefs = await makeService({ autoTagOnUpload: true, autoTagOnIngest: false })
    .getPreferences("u1");

  assert.equal(prefs.autoTagOnIngest, false);
});

test("getPreferences: a null preferences column yields the defaults", async () => {
  const prefs = await makeService(null).getPreferences("u1");

  assert.equal(prefs.autoTagOnIngest, true);
});

test("listIndexConfigs: legacy keys don't break the watcher's config read", async () => {
  const configs = await makeService({
    autoTagOnUpload: false,
    indexAllowedRoots: ["/data"],
  }).listIndexConfigs();

  assert.equal(configs.length, 1);
  assert.deepEqual(configs[0].allowedRoots, ["/data"]);
});
