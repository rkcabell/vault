import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs, run, type ResetDeps } from "@/lib/resetPassword.js";

// ── parseArgs ───────────────────────────────────────────────────────────────

test("parseArgs: space and equals forms", () => {
  assert.deepEqual(parseArgs(["--email", "a@b.com", "--password", "secret"]), {
    email: "a@b.com",
    password: "secret",
  });
  assert.deepEqual(parseArgs(["--email=a@b.com", "--password=secret"]), {
    email: "a@b.com",
    password: "secret",
  });
  assert.deepEqual(parseArgs([]), {});
});

// ── run ─────────────────────────────────────────────────────────────────────

type UpdateCall = { where: { id: string }; data: Record<string, unknown> };

function makeDeps(
  user: { id: string; email: string } | null,
  over: Partial<ResetDeps> = {},
): { deps: ResetDeps; updates: UpdateCall[] } {
  const updates: UpdateCall[] = [];
  const deps: ResetDeps = {
    prisma: {
      user: {
        findUnique: async () => user,
        update: async (args) => {
          updates.push(args as UpdateCall);
          return {};
        },
      },
    },
    hasher: { hash: async (p: string) => `hashed:${p}` },
    readPassword: async () => "interactivePass1",
    isTTY: true,
    log: () => {},
    error: () => {},
    ...over,
  };
  return { deps, updates };
}

test("run: missing --email returns 2 and never touches the DB", async () => {
  const { deps, updates } = makeDeps({ id: "u1", email: "a@b.com" });
  const code = await run({}, deps);
  assert.equal(code, 2);
  assert.equal(updates.length, 0);
});

test("run: unknown email returns 1", async () => {
  const { deps, updates } = makeDeps(null);
  const code = await run({ email: "nobody@b.com" }, deps);
  assert.equal(code, 1);
  assert.equal(updates.length, 0);
});

test("run: weak password is rejected before any write", async () => {
  const { deps, updates } = makeDeps({ id: "u1", email: "a@b.com" });
  const code = await run({ email: "a@b.com", password: "short" }, deps);
  assert.equal(code, 1);
  assert.equal(updates.length, 0);
});

test("run: valid password hashes, nulls reset fields, returns 0", async () => {
  const { deps, updates } = makeDeps({ id: "u1", email: "a@b.com" });
  const code = await run({ email: "a@b.com", password: "Tr0ubadour-9x" }, deps);
  assert.equal(code, 0);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].where.id, "u1");
  assert.equal(updates[0].data.passwordHash, "hashed:Tr0ubadour-9x");
  assert.equal(updates[0].data.resetToken, null);
  assert.equal(updates[0].data.resetTokenExpiry, null);
});

test("run: no password without a TTY returns 2 (must pass --password)", async () => {
  const { deps, updates } = makeDeps({ id: "u1", email: "a@b.com" }, { isTTY: false });
  const code = await run({ email: "a@b.com" }, deps);
  assert.equal(code, 2);
  assert.equal(updates.length, 0);
});

test("run: interactive password path is used when --password is absent", async () => {
  const { deps, updates } = makeDeps(
    { id: "u1", email: "a@b.com" },
    { readPassword: async () => "Tr0ubadour-9x" },
  );
  const code = await run({ email: "a@b.com" }, deps);
  assert.equal(code, 0);
  assert.equal(updates[0].data.passwordHash, "hashed:Tr0ubadour-9x");
});
