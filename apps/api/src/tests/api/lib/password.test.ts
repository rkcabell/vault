import test from "node:test";
import assert from "node:assert/strict";
import {
  validatePassword,
  PASSWORD_MIN_LENGTH,
  PASSWORD_MAX_LENGTH,
} from "@vault/types";

test("validatePassword: accepts a reasonable password", () => {
  const result = validatePassword("Tr0ubadour-9x");
  assert.deepEqual(result, { ok: true });
});

test("validatePassword: accepts exactly the minimum length", () => {
  assert.equal(validatePassword("a".repeat(PASSWORD_MIN_LENGTH - 1) + "b").ok, true);
});

test("validatePassword: rejects too-short with the stable message", () => {
  const result = validatePassword("short");
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /8 characters/i);
});

test("validatePassword: rejects over the max length", () => {
  const result = validatePassword("a1".repeat(PASSWORD_MAX_LENGTH));
  assert.equal(result.ok, false);
});

test("validatePassword: rejects common passwords (case-insensitive)", () => {
  for (const pw of ["password", "PASSWORD", "12345678", "changeme", "admin123"]) {
    const result = validatePassword(pw);
    assert.equal(result.ok, false, `${pw} should be rejected`);
  }
});

test("validatePassword: exact-match blocklist does not reject longer variants", () => {
  // "password" is blocked, but "password1234" is a distinct (still weak-ish)
  // value that must pass — exact match, not substring.
  assert.equal(validatePassword("password1234").ok, true);
});

test("validatePassword: rejects all-identical characters", () => {
  assert.equal(validatePassword("aaaaaaaa").ok, false);
});
