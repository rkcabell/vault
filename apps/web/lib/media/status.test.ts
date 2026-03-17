import test from "node:test";
import assert from "node:assert/strict";
import { deriveOverallState } from "./status.js";

// ---------------------------------------------------------------------------
// Error states take priority
// ---------------------------------------------------------------------------

test("ERROR on either field returns ERROR", () => {
  assert.equal(deriveOverallState("ERROR", "READY"), "ERROR");
  assert.equal(deriveOverallState("READY", "ERROR"), "ERROR");
  assert.equal(deriveOverallState("ERROR", "ERROR"), "ERROR");
});

test("FAILED on either field returns ERROR", () => {
  assert.equal(deriveOverallState("FAILED", "READY"), "ERROR");
  assert.equal(deriveOverallState("READY", "FAILED"), "ERROR");
  assert.equal(deriveOverallState("FAILED", "FAILED"), "ERROR");
});

test("FAILED + ERROR still returns ERROR", () => {
  assert.equal(deriveOverallState("FAILED", "ERROR"), "ERROR");
  assert.equal(deriveOverallState("ERROR", "FAILED"), "ERROR");
});

// ---------------------------------------------------------------------------
// Pending — one or both fields still in flight
// ---------------------------------------------------------------------------

test("PENDING on either field returns PENDING", () => {
  assert.equal(deriveOverallState("PENDING", "READY"), "PENDING");
  assert.equal(deriveOverallState("READY", "PENDING"), "PENDING");
  assert.equal(deriveOverallState("PENDING", "PENDING"), "PENDING");
});

// ---------------------------------------------------------------------------
// Ready — both fields complete
// ---------------------------------------------------------------------------

test("both READY returns READY", () => {
  assert.equal(deriveOverallState("READY", "READY"), "READY");
});

// ---------------------------------------------------------------------------
// Null / undefined default to PENDING
// ---------------------------------------------------------------------------

test("null is treated as PENDING", () => {
  assert.equal(deriveOverallState(null, "READY"), "PENDING");
  assert.equal(deriveOverallState("READY", null), "PENDING");
  assert.equal(deriveOverallState(null, null), "PENDING");
});

test("undefined is treated as PENDING", () => {
  assert.equal(deriveOverallState(undefined, "READY"), "PENDING");
  assert.equal(deriveOverallState("READY", undefined), "PENDING");
  assert.equal(deriveOverallState(), "PENDING");
});

test("null does not override an ERROR", () => {
  assert.equal(deriveOverallState("ERROR", null), "ERROR");
  assert.equal(deriveOverallState(null, "FAILED"), "ERROR");
});
