import test from "node:test";
import assert from "node:assert/strict";
import {
  checkOrigin,
  isStateChanging,
  normalizeOrigin,
  parseAllowedOrigins,
} from "@/lib/http/originCheck.js";

const ALLOWED = ["https://vault.example.com"];

test("only the methods that can change state are checked", () => {
  for (const m of ["GET", "HEAD", "OPTIONS", "get", "head", "options"]) {
    assert.equal(isStateChanging(m), false, m);
  }
  for (const m of ["POST", "PUT", "PATCH", "DELETE", "post"]) {
    assert.equal(isStateChanging(m), true, m);
  }
});

test("normalizing drops the default port, lowercases, and strips the path", () => {
  assert.equal(normalizeOrigin("https://Vault.Example.com:443"), "https://vault.example.com");
  assert.equal(normalizeOrigin("http://localhost:3000/some/path"), "http://localhost:3000");
  assert.equal(normalizeOrigin("https://vault.example.com:8443"), "https://vault.example.com:8443");
});

test("an opaque origin normalizes to null rather than to something matchable", () => {
  // A sandboxed iframe and a file:// page both send the literal string "null".
  assert.equal(normalizeOrigin("null"), null);
  assert.equal(normalizeOrigin(""), null);
  assert.equal(normalizeOrigin(undefined), null);
  assert.equal(normalizeOrigin("vault.example.com"), null);
});

test("the allow-list splits, normalizes and de-duplicates", () => {
  assert.deepEqual(parseAllowedOrigins("https://a.example.com, http://localhost:3000"), [
    "https://a.example.com",
    "http://localhost:3000",
  ]);
  assert.deepEqual(parseAllowedOrigins("https://A.example.com:443,https://a.example.com"), [
    "https://a.example.com",
  ]);
});

test("`*` is off, not empty — an empty list would reject everything", () => {
  assert.equal(parseAllowedOrigins("*"), null);
  assert.equal(parseAllowedOrigins(" * "), null);
  assert.deepEqual(parseAllowedOrigins("not-a-url"), []);
  assert.deepEqual(parseAllowedOrigins(undefined), []);
});

test("a matching Origin passes", () => {
  assert.deepEqual(checkOrigin({ origin: "https://vault.example.com" }, ALLOWED), { ok: true });
});

test("a foreign Origin is rejected and reported verbatim", () => {
  assert.deepEqual(checkOrigin({ origin: "https://evil.example.com" }, ALLOWED), {
    ok: false,
    header: "origin",
    value: "https://evil.example.com",
  });
});

test("an opaque Origin is rejected rather than treated as absent", () => {
  assert.deepEqual(checkOrigin({ origin: "null" }, ALLOWED), {
    ok: false,
    header: "origin",
    value: "null",
  });
});

test("a lookalike host does not match by prefix or suffix", () => {
  for (const origin of [
    "https://vault.example.com.evil.test",
    "https://evil-vault.example.com",
    "http://vault.example.com",
  ]) {
    assert.equal(checkOrigin({ origin }, ALLOWED).ok, false, origin);
  }
});

test("Referer is consulted only when Origin is absent", () => {
  assert.equal(
    checkOrigin({ referer: "https://vault.example.com/library" }, ALLOWED).ok,
    true,
  );
  assert.deepEqual(checkOrigin({ referer: "https://evil.example.com/x" }, ALLOWED), {
    ok: false,
    header: "referer",
    value: "https://evil.example.com/x",
  });
  // A present-but-foreign Origin is not rescued by a friendly Referer.
  assert.equal(
    checkOrigin({ origin: "https://evil.example.com", referer: "https://vault.example.com/" }, ALLOWED)
      .ok,
    false,
  );
});

test("neither header present is allowed — that is curl, not a browser", () => {
  assert.deepEqual(checkOrigin({}, ALLOWED), { ok: true });
});
